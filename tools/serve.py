#!/usr/bin/env python3
"""本地预览用的静态服务器 + 文件监听自动刷新（纯开发工具，不参与部署）。

为什么不用 python3 -m http.server：它的 listen backlog 只有 5，而页面拆成 ES 模块后
一次要并发拉十几个 .js，超出的连接会被直接 reset —— 表现为偶尔整页空白、控制台里
一串 ERR_CONNECTION_RESET。这里把 backlog 放大，并且禁掉缓存（改了子模块不必硬刷）。

自动刷新分两档，因为这两类改动的代价差很多：
  - 改 CSS：只给 <link> 换一个查询串，页面状态全留着。调卡片版式时要的就是
    「提交三次猜测 → 改一行 → 立刻看到结算卡变化」，整页刷会把猜测重置掉。
  - 改 JS / HTML：整页 reload。ES 模块图没有安全的热替换点，硬换只留下半新半旧的闭包。

监听用快照轮询而不是 kqueue/inotify：递归盯目录要自己维护一张 fd 表、跨平台还得写两套，
而这里一共二十来个文件，每 300ms 一次 stat 快照做 diff 更短也更难写错。

通知走 SSE（EventSource）而不是 WebSocket：SSE 就是普通 HTTP 响应，标准库几十行搞定，
WebSocket 还得自己解握手和帧掩码。代价是它常驻占一条连接 —— Chrome 对同一 origin 的
HTTP/1.1 只有 6 条并发连接，SSE 占掉 1 条，只剩 5 条给首屏那十几个模块。所以静态响应
一并升到 HTTP/1.1 让连接能 keep-alive 复用，抵消掉这个槽位；localhost 上排队本来就无感。
但那个池子是整个浏览器进程共享的，不是每页一份：开到第六个标签页就会把池子占满，
后面的 CSS/JS 请求一直排队，症状是整页无样式（实测过，别当成样式写坏了）。

注入的 <script> 只存在于服务器吐出的响应里，不写进 index.html —— 那是要发布到
GitHub Pages 的，线上一条指向 /__lr 的常驻请求既拿不到东西又会一直重连。

用法：python3 tools/serve.py [端口]   # 默认 8000，然后开 http://127.0.0.1:8000/
"""
import http.server
import json
import os
import queue
import socketserver
import sys
import threading
import time
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
# 从任意目录启动都指向仓库根，省得「cd 错了地方、服务起了个空目录」这种查半天的坑
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 只有会被浏览器加载的东西值得热刷；tools/ 自己改了得重启进程，不参与监听
WATCH = ("index.html", "src")
# 自测产物（对拍用的合并样式与 harness）改得再勤也不该刷掉你正在看的页面
IGNORE_DIRS = {".git", "_qa", "__pycache__"}
POLL_SECONDS = 0.3
SSE_PING_SECONDS = 15

# 注：LR_SCRIPT 是 bytes，里面只能写 ASCII，所以这段 JS 的注释用英文。
# 两个设计点：一是 CSS 热换只加一个 lr= 时间戳，不动 index.html 里有语义的 ?v=；
# 服务器本来就发 no-store，换串一是绕开个别浏览器对已解析样式表的复用，二是让
# DevTools 的 Network 里数得出这一轮热了几次。二是 event 里只传 {reload: bool}，
# 具体刷什么由页面自己判断，服务端不需要知道客户端长什么样。
LR_SCRIPT = b"""<script data-lr>
(function () {
  var lr = new EventSource("/__lr");
  lr.onmessage = function (ev) {
    var msg = JSON.parse(ev.data);
    if (msg.reload) { location.reload(); return; }
    // CSS hot swap: replace the stamp, keep the release ?v= intact.
    // Appending without stripping first makes the query grow on every save --
    // one hour of tweaking a card layout and each <link> carries hundreds of &lr=.
    [].forEach.call(document.querySelectorAll('link[rel="stylesheet"]'), function (link) {
      var parts = link.href.split("?");
      var q = (parts[1] || "").replace(/(^|&)lr=[^&]*/g, "").replace(/^&/, "");
      link.href = parts[0] + "?" + (q ? q + "&" : "") + "lr=" + Date.now();
    });
  };
})();
</script>
"""


def rel(path):
    return os.path.relpath(path, ROOT)


class Broker:
    """每个 SSE 连接一个队列：watcher 线程只管往队列里放，写 socket 仍由自己的线程做。"""

    def __init__(self):
        self._subs = set()
        self._lock = threading.Lock()

    def subscribe(self):
        q = queue.Queue()
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            self._subs.discard(q)

    def publish(self, payload):
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            q.put(payload)


def snapshot():
    """{路径: (mtime_ns, size)}。用 mtime+size 而不是内容哈希： stat 便宜到可以每 300ms 全量跑。"""

    seen = {}

    def one(path):
        try:
            st = os.stat(path)
        except OSError:
            return  # 刚好被删了，下一轮 diff 会当成 removed
        seen[path] = (st.st_mtime_ns, st.st_size)

    for name in WATCH:
        top = os.path.join(ROOT, name)
        if os.path.isfile(top):
            one(top)
        elif os.path.isdir(top):
            for dirpath, dirnames, filenames in os.walk(top):
                dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS]
                for fn in filenames:
                    one(os.path.join(dirpath, fn))
    return seen


def watch(broker):
    prev = snapshot()
    while True:
        time.sleep(POLL_SECONDS)
        cur = snapshot()
        changed = [p for p in cur if p not in prev or prev[p] != cur[p]]
        removed = [p for p in prev if p not in cur]
        prev = cur
        if not changed and not removed:
            continue
        css = [p for p in changed if p.endswith(".css")]
        # 删掉任何文件都整页刷：热换一个 404 的 <link> 只会留下看不出原因的旧样式
        other = [p for p in changed if p not in css] + removed
        if other:
            print("[lr] reload  {}".format(" ".join(rel(p) for p in other)), flush=True)
            broker.publish({"reload": True})
        else:
            print("[lr] css     {}".format(" ".join(rel(p) for p in css)), flush=True)
            broker.publish({"reload": False})


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # 让静态响应 keep-alive，别和常驻的 SSE 抢那 6 个槽
    timeout = 60  # 空闲连接超时回收，否则 keep-alive 会把线程一直挂住
    broker = None  # 由 main() 注入
    _own_cache_header = False  # SSE 自己已经写过 Cache-Control，别让 end_headers 再补一条

    def end_headers(self):
        if not self._own_cache_header:
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        if self.path.startswith("/__lr"):  # SSE 的心跳别刷屏
            return
        super().log_message(fmt, *args)

    def do_GET(self):
        if urlparse(self.path).path == "/__lr":
            return self._event_stream()
        html = self._injectable()
        if html:
            return self._send_injected(html)
        return super().do_GET()

    def _injectable(self):
        """命中要注入的 .html（含目录 → index.html），否则 None 交回父类的零拷贝路径。"""
        fs = self.translate_path(self.path)
        if os.path.isdir(fs):
            fs = os.path.join(fs, "index.html")
        return fs if fs.endswith(".html") and os.path.isfile(fs) else None

    def _send_injected(self, fs):
        with open(fs, "rb") as fh:
            raw = fh.read()
        # 插到 </body> 前：脚本要 querySelectorAll，放 head 里跑得太早
        i = raw.rfind(b"</body>")
        body = raw[:i] + LR_SCRIPT + raw[i:] if i >= 0 else raw + LR_SCRIPT
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _event_stream(self):
        q = self.broker.subscribe()
        self._own_cache_header = True
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            self.wfile.write(b": lr open\n\n")
            self.wfile.flush()
            while True:
                try:
                    payload = q.get(timeout=SSE_PING_SECONDS)
                except queue.Empty:
                    # 注释帧：保活，顺带探出连接已经断了。必须是 bytes —— 上一版写成 str，
                    # 抛 TypeError 且不被下面那行 except 接住，每个挂满 15 秒的连接都在服务端
                    # 吐一屏 traceback；短测根本碰不到这条路径，只有截图脚本这种一跑半分钟的会踩中。
                    payload = b": ping\n\n"
                else:
                    if payload is None:
                        return
                    payload = "data: {}\n\n".format(json.dumps(payload)).encode()
                self.wfile.write(payload)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # 浏览器刷新 / 关页就是正常断连，不值得打一行报错
        finally:
            self.broker.unsubscribe(q)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    request_queue_size = 128
    daemon_threads = True

    def handle_error(self, request, client_address):
        # 刷新 / 关页会 RST 掉 keep-alive 连接，正在写的响应就炸。socketserver 把它当成
        # 「请求处理异常」打整屏 traceback —— 跑一轮截图能刷出七十几屏，真问题反倒埋在里面。
        # 注意这个方法在 Server 上不在 Handler 上：process_request_thread 里的 self 是服务器，
        # 覆盖到 Handler.handle_error 是接不到的（上一版就白写在那儿）。
        # 只吞这两类正常断连，其余异常照旧上报，别把真故障一起遮了。
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def main():
    os.chdir(ROOT)
    broker = Broker()
    Handler.broker = broker
    threading.Thread(target=watch, args=(broker,), daemon=True).start()
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print("http://127.0.0.1:{}/  (Ctrl+C 停止)".format(PORT))
        print("监听 {}；改 CSS 热换、改 JS/HTML 整页刷".format("、".join(WATCH)))
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            broker.publish(None)  # 让还挂着的 SSE 线程自己 return，Ctrl+C 才不会卡在退出上


if __name__ == "__main__":
    main()
