"""Exercise #1048 inside wayland-smoke.sh's disposable session."""
import http.client
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time

image, user_data, runtime_file, mount_dir = sys.argv[1:]
image = str(Path(image).resolve())
marker = "--user-data-dir=" + user_data
runtime = json.loads(Path(runtime_file).read_text())


def inspect(pid):
    proc = Path("/proc") / str(pid)
    try:
        args = [a.decode() for a in (proc / "cmdline").read_bytes().split(b"\0") if a]
        fields = (proc / "stat").read_text().rsplit(") ", 1)[1].split()
        return {"pid": int(pid), "args": args, "exe": os.readlink(proc / "exe"), "start": fields[19]}
    except (OSError, ValueError):
        return None


def open_owned(item):
    assert item and marker in item["args"], "process is not owned by this test"
    fd = os.pidfd_open(item["pid"])
    assert inspect(item["pid"]) == item, "process identity changed"
    return fd


def state_ok():
    conn = http.client.HTTPConnection("127.0.0.1", runtime["port"], timeout=1)
    try:
        conn.request("GET", "/state")
        response = conn.getresponse()
        response.read()
        return response.status == 200
    finally:
        conn.close()


fds = []
try:
    main = inspect(runtime["ownerPid"])
    assert main and Path(main["exe"]).name == "clawd-on-desk"
    assert "/clawd-appimage." in main["exe"], "main still runs from the FUSE payload"
    main_fd = open_owned(main)
    fds.append(main_fd)
    wrappers = []
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        item = inspect(proc.name)
        if item and item["exe"] == image and marker in item["args"]:
            fd = open_owned(item)
            fds.append(fd)
            wrappers.append((item, fd))
    assert wrappers, "no owned AppImage wrapper found"
    assert subprocess.run(["mountpoint", "-q", "--", mount_dir]).returncode == 0, "FUSE mount was already gone"
    assert state_ok(), "main is not healthy before wrapper termination"
    for _, fd in wrappers:
        signal.pidfd_send_signal(fd, signal.SIGTERM)
    for _, fd in wrappers:
        poll = select.poll()
        poll.register(fd, select.POLLIN)
        assert poll.poll(5000), "wrapper did not exit"
    deadline = time.monotonic() + 5
    while subprocess.run(["mountpoint", "-q", "--", mount_dir]).returncode == 0:
        assert time.monotonic() < deadline, "FUSE mount survived wrapper termination"
        time.sleep(0.05)
    assert state_ok(), "main stopped serving after wrapper termination"
    assert Path(main["exe"]).is_file(), "backing executable disappeared"
    started = time.monotonic()
    signal.pidfd_send_signal(main_fd, signal.SIGTERM)
    poll = select.poll()
    poll.register(main_fd, select.POLLIN)
    assert poll.poll(15000), "main did not finish shutdown"
    print(json.dumps({"mainPid": main["pid"], "wrapperPids": [p["pid"] for p, _ in wrappers],
                      "backingExecutable": main["exe"], "runtimeDirectory": str(Path(main["exe"]).parent.parent),
                      "originalMount": mount_dir, "exitSeconds": time.monotonic() - started}))
finally:
    for fd in fds:
        os.close(fd)
