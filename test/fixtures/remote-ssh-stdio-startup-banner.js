"use strict";

process.stdout.write(Buffer.concat([
  Buffer.from("Gateway login\n欢迎使用跳板机\n"),
  Buffer.from([0xff, 0xfe, 0x80]),
  Buffer.from("\n__clawd_stdio_begin__:" + "f".repeat(32) + "\nBanner complete\n"),
]));
require("../../hooks/remote-ssh-stdio-bridge.js");
