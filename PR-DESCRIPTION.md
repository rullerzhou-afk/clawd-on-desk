# feat: session type system for local/remote PID detection + token usage tracking

## 问题背景

原项目的 session 存活检测依赖 PID 检测，但在 **WSL2/远程环境** 下存在问题：

- 远程环境的 PID（如 WSL2 里的进程号）在本地 Windows 上无法检测
- `isProcessAlive(pid)` 对远程 PID 返回 false，导致活跃会话被误删
- 用户在 WSL2 里运行 Claude Code 时，宠物显示"0 sessions"

## 解决方案

引入 **Session 类型系统**，根据 PID 可达性自动选择检测策略：

```
Session (基类)
├── LocalSession  - PID 本地可达，使用 PID 检测 + 超时
└── RemoteSession - PID 不可达（远程），仅使用超时
```

**创建时判断逻辑：**
```javascript
// SessionFactory.create(sessionId, pid, metadata)
// 尝试检测 PID 是否本地存活
if (pid && isProcessAlive(pid)) {
  return new LocalSession(sessionId, pid, metadata);  // 本地会话
} else {
  return new RemoteSession(sessionId, pid, metadata); // 远程会话
}
```

**alive() 行为差异：**

| 检测项 | LocalSession | RemoteSession |
|--------|--------------|---------------|
| Agent 进程死亡检测 | ✓ 立即删除 | ✗ |
| Terminal 进程死亡检测 | ✓ 立即删除 | ✗ |
| working/juggling/thinking 降级 | ✓ 5min | ✓ 5min |
| 超时删除 | ✓ 5min | ✓ 5min |

## 新增功能

1. **Token Usage 追踪** - 异步读取 transcript 提取 input/output tokens，在 session 菜单显示
2. **Debug Mode 开关** - 默认关闭，开启后才记录日志，避免文件膨胀

## 兼容性

- 保留所有原有字段（`sourcePid`, `cwd`, `editor`, `pidChain`, `agentPid`, `agentId`）
- API 保持向后兼容
- 与上游多 Agent 架构合并

## 测试场景

- [x] 本地 Windows 运行 Claude Code → LocalSession
- [x] WSL2 运行 Claude Code + SSH 隧道 → RemoteSession
- [x] Session 正常结束时显式删除
- [x] 长时间无更新时超时删除
