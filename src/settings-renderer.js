"use strict";

// ── Settings panel renderer ──
//
// Strict unidirectional flow (plan §4.2):
//
//   1. UI clicks → settingsAPI.update(key, value) → main → controller
//   2. Controller commits → broadcasts settings-changed
//   3. settingsAPI.onChanged fires → renderer syncs the active tab
//
// Broadcast state is still authoritative, but controls keep a tiny transient
// UI layer so switches can animate immediately and slider drags don't get
// interrupted by high-frequency size broadcasts.

const {
  SIZE_UI_MIN,
  SIZE_UI_MAX,
  SIZE_TICK_VALUES,
  uiSizeToPrefs,
  prefsSizeToUi,
  clampSizeUi,
  sizeUiToPct,
  createSizeSliderController,
} = globalThis.ClawdSettingsSizeSlider || {};

if (!createSizeSliderController) {
  throw new Error("settings-size-slider.js failed to load before settings-renderer.js");
}

// ── i18n (mirror src/i18n.js — bubbles can't require electron modules) ──
const STRINGS = {
  en: {
    settingsTitle: "Settings",
    settingsSubtitle: "Configure how Clawd behaves on your desktop.",
    sidebarGeneral: "General",
    sidebarAgents: "Agents",
    sidebarTheme: "Theme",
    sidebarAnimMap: "Animation Map",
    sidebarAnimOverrides: "Animation Overrides",
    sidebarShortcuts: "Shortcuts",
    sidebarAbout: "About",
    shortcutsTitle: "Shortcuts",
    shortcutsSubtitle: "Set global shortcuts for pet visibility and permission actions. Leave a field empty to unbind it.",
    shortcutRecordButton: "Change",
    shortcutClearButton: "Clear",
    shortcutResetButton: "Reset",
    shortcutResetAllButton: "Reset All",
    shortcutRecordingHint: "Press keys (Esc)",
    shortcutUnassigned: "— unassigned —",
    shortcutErrorConflict: "Conflict with {other}. Try another key.",
    shortcutErrorSystemConflict: "Already in use by system or another app.",
    shortcutErrorReserved: "This combination is reserved. Try another key.",
    shortcutErrorInvalid: "That key combination is not supported.",
    shortcutErrorNeedsModifier: "Shortcut must include at least one modifier key.",
    shortcutErrorRegistrationFailed: "Saved, but currently not active due to system conflict. Rebind or try again later.",
    shortcutLabelTogglePet: "Toggle pet visibility",
    shortcutLabelPermissionAllow: "Permission: Allow",
    shortcutLabelPermissionDeny: "Permission: Deny",
    shortcutToastSaved: "Shortcut updated",
    sidebarSoon: "Soon",
    sectionAppearance: "Appearance",
    sectionStartup: "Startup",
    sectionBubbles: "Bubbles",
    agentsTitle: "Agents",
    agentsSubtitle: "Turn tracking on or off per agent. Disabled agents stop log monitors and drop hook events at the HTTP boundary — they won't drive the pet, show permission bubbles, or keep sessions.",
    agentsEmpty: "No agents registered.",
    eventSourceHook: "Hook",
    eventSourceLogPoll: "Log poll",
    eventSourcePlugin: "Plugin",
    badgePermissionBubble: "Permission bubble",
    rowAgentPermissions: "Show pop-up bubbles",
    rowAgentPermissionsDesc: "Turn off to let this agent handle prompts in its own terminal instead of showing a Clawd bubble.",
    rowLanguage: "Language",
    rowLanguageDesc: "Interface language for menus and bubbles.",
    rowSound: "Sound effects",
    rowSoundDesc: "Play a chime when Clawd finishes a task or asks for input.",
    rowOpenAtLogin: "Open at login",
    rowOpenAtLoginDesc: "Start Clawd automatically when you log in.",
    rowManageClaudeHooks: "Manage Claude hooks automatically",
    rowManageClaudeHooksDesc: "Sync Claude hooks at startup and restore them if ~/.claude/settings.json gets overwritten.",
    rowManageClaudeHooksOffNote: "Turning this off stops future automatic management only. Existing Claude hooks stay installed unless you disconnect them.",
    actionDisconnectClaudeHooks: "Disconnect",
    rowStartWithClaude: "Start with Claude Code",
    rowStartWithClaudeDesc: "Auto-launch Clawd whenever a Claude Code session starts.",
    rowStartWithClaudeDisabledDesc: "Requires automatic Claude hook management. Port changes and overwritten settings will not be reconciled while management is off.",
    rowBubbleFollow: "Bubbles follow Clawd",
    rowBubbleFollowDesc: "Place permission and update bubbles next to the pet instead of the screen corner.",
    rowHideBubbles: "Hide all bubbles",
    rowHideBubblesDesc: "Suppress permission, notification, and update bubbles entirely.",
    rowShowSessionId: "Show session ID",
    rowShowSessionIdDesc: "Append the short session ID to bubble headers and the Sessions menu.",
    rowAllowEdgePinning: "Allow pinning to screen edges",
    rowAllowEdgePinningDesc: "Top/bottom decorations (sparkles, buildings, bubbles, …) may be clipped by the screen edge",
    rowSize: "Size",
    rowSizeDesc: "Drag to resize the pet.",
    placeholderTitle: "Coming soon",
    placeholderDesc: "This panel will land in a future Clawd release. The plan lives in docs/plans/plan-settings-panel.md.",
    toastSaveFailed: "Couldn't save: ",
    langEnglish: "English",
    langChinese: "中文",
    langKorean: "한국어",
    themeTitle: "Theme",
    themeSubtitle: "Pick a theme for Clawd. Cards show built-in + capability badges so you can see tracked/static/mini differences before switching.",
    themeEmpty: "No themes available.",
    themeBadgeBuiltin: "Built-in",
    themeBadgeActive: "Active",
    themeCapabilityTracked: "Tracked idle",
    themeCapabilityAnimated: "Animated idle",
    themeCapabilityStatic: "Static theme",
    themeCapabilityMini: "Mini",
    themeCapabilityDirectSleep: "Direct sleep",
    themeCapabilityNoReactions: "No reactions",
    themeActiveIndicator: "\u2713 Active",
    themeThumbMissing: "\u{1F3AD}",
    themeDeleteLabel: "Delete theme",
    themeVariantStripLabel: "Variants",
    toastThemeDeleted: "Theme deleted.",
    toastThemeDeleteFailed: "Couldn't delete theme: ",
    animMapTitle: "Animation Map",
    animMapSubtitle: "Silence individual interrupt animations. Events still fire — Clawd just skips the visual and sound for the selected states.",
    animMapSemanticsNote: "Disable = no visual + no sound. Permission bubbles, sessions, and terminal focus still work.",
    animMapResetAll: "Reset all",
    animMapAttentionLabel: "Task complete (happy)",
    animMapAttentionDesc: "The happy bounce when the agent finishes a turn (Stop / PostCompact).",
    animMapErrorLabel: "Error flash",
    animMapErrorDesc: "The shake animation when a tool call fails.",
    animMapSweepingLabel: "Context sweep",
    animMapSweepingDesc: "The broom animation during PreCompact / context clearing.",
    animMapNotificationLabel: "Notification",
    animMapNotificationDesc: "The bell animation for permission requests and elicitations.",
    animMapCarryingLabel: "Worktree carry",
    animMapCarryingDesc: "The carrying animation when a worktree is created.",
    toastAnimMapResetOk: "Animation overrides cleared.",
    animOverridesTitle: "Animation Overrides",
    animOverridesSubtitle: "Swap per-card files and adjust fade / return timing for the current theme.",
    animOverridesCurrentTheme: "Current theme",
    animOverridesOpenThemeTab: "Open Theme tab",
    animOverridesOpenAssets: "Open assets folder",
    animOverridesResetAll: "Reset all to default",
    animOverridesExport: "Export…",
    animOverridesImport: "Import…",
    toastAnimOverridesExportOk: (count, path) =>
      `Exported overrides for ${count} theme${count === 1 ? "" : "s"} → ${path}`,
    toastAnimOverridesImportOk: (count) =>
      `Imported overrides for ${count} theme${count === 1 ? "" : "s"}.`,
    toastAnimOverridesExportEmpty: "No overrides to export yet.",
    toastAnimOverridesExportFailed: (message) => `Export failed: ${message}`,
    toastAnimOverridesImportFailed: (message) => `Import failed: ${message}`,
    animOverridesChangeFile: "Change file",
    animOverridesPreview: "Preview once",
    animOverridesReset: "Reset slot",
    animOverridesFade: "Fade",
    animOverridesFadeIn: "In",
    animOverridesFadeOut: "Out",
    animOverridesSaveFade: "Save fade",
    animOverridesDuration: "Auto-return",
    animOverridesSaveDuration: "Save timing",
    animOverridesContinuousHint: "Continuous state: no auto-return editor here.",
    animOverridesAssetCycle: "Asset cycle",
    animOverridesSuggestedTiming: "Suggested timing",
    animOverridesTimingEstimated: "estimated",
    animOverridesTimingFallback: "theme default",
    animOverridesTimingUnavailable: "unavailable",
    animOverridesDisplayHintWarning: "displayHintMap can override this slot at runtime.",
    animOverridesFallbackHint: "This slot currently falls back to {state}.",
    animOverridesOverriddenTooltip: "Modified from default",
    animOverridesUseOwnFile: "Use own file",
    animOverridesDurationIdle: "Pool hold",
    animOverridesSectionIdle: "Idle",
    animOverridesSectionWork: "Work",
    animOverridesSectionInterrupts: "Interrupts",
    animOverridesSectionSleep: "Sleep",
    animOverridesSectionMini: "Mini Mode",
    animOverridesSectionReactions: "Reactions",
    animOverridesSectionIdleTracked: "Cursor-follow idle",
    animOverridesSectionIdleAnimated: "Idle random pool",
    animOverridesSectionIdleStatic: "Single static idle",
    animOverridesSectionSleepFull: "Full sleep sequence",
    animOverridesSectionSleepDirect: "Direct sleep only",
    animReactionDrag: "Drag (held)",
    animReactionClickLeft: "Poke (left)",
    animReactionClickRight: "Poke (right)",
    animReactionAnnoyed: "Annoyed (rapid poke)",
    animReactionDouble: "Double-tap",
    animOverridesWideHitboxToggle: "Wide hitbox",
    animOverridesWideHitboxDesc: "Use a wider click zone for this frame. Helpful when the visual reaches beyond the default pet silhouette.",
    animOverridesWideHitboxResetToTheme: "Reset to theme default",
    animOverridesAspectWarning: "This asset's aspect ratio differs from the original by {pct}% — the hitbox and positioning may need manual tuning.",
    animOverridesExpandRow: "Expand",
    animOverridesModalTitle: "Choose an asset file",
    animOverridesModalSubtitle: "Add files to the current theme assets folder, then refresh the list here.",
    animOverridesModalEmpty: "No supported assets found in this theme yet.",
    animOverridesModalSelected: "Selected file",
    animOverridesModalUse: "Use this file",
    animOverridesModalCancel: "Cancel",
    animOverridesRefresh: "Refresh list",
    aboutTitle: "About Clawd",
    aboutSubtitle: "The pixel crab that watches your AI coding sessions.",
    aboutTagline: "A desktop companion for your AI coding journey.",
    aboutVersionLabel: "Version",
    aboutCheckForUpdates: "Check for Updates",
    aboutRepositoryLabel: "Repository",
    aboutLicenseLabel: "License",
    aboutAuthorLabel: "Made by",
    aboutContributorsLabel: "Contributors",
    aboutContributorsShowAll: "Show all",
    aboutContributorsHide: "Hide",
    aboutFooter: "Clawd is open source. Built with care by the community.",
    aboutEasterEggToast: "\u{1F980} Coding shouldn't feel lonely. — Ruller_Lulu / \u9e7f\u9e7f",
    aboutOpenExternalFailed: "Couldn't open the link in your browser.",
  },
  zh: {
    settingsTitle: "设置",
    settingsSubtitle: "配置 Clawd 在桌面上的行为。",
    sidebarGeneral: "通用",
    sidebarAgents: "Agent 管理",
    sidebarTheme: "主题",
    sidebarAnimMap: "动画映射",
    sidebarAnimOverrides: "动画替换",
    sidebarShortcuts: "快捷键",
    sidebarAbout: "关于",
    shortcutsTitle: "快捷键",
    shortcutsSubtitle: "为桌宠显隐和权限操作设置全局快捷键。留空即可解绑。",
    shortcutRecordButton: "修改",
    shortcutClearButton: "清空",
    shortcutResetButton: "恢复默认",
    shortcutResetAllButton: "全部恢复默认",
    shortcutRecordingHint: "按下组合键（Esc）",
    shortcutUnassigned: "— 未绑定 —",
    shortcutErrorConflict: "与 {other} 冲突，请换一个组合键。",
    shortcutErrorSystemConflict: "该组合键已被系统或其他应用占用。",
    shortcutErrorReserved: "该组合键属于保留快捷键，请换一个。",
    shortcutErrorInvalid: "暂不支持这个组合键。",
    shortcutErrorNeedsModifier: "快捷键至少要包含一个修饰键。",
    shortcutErrorRegistrationFailed: "已保存，但当前因系统冲突未生效。请重新绑定或稍后再试。",
    shortcutLabelTogglePet: "显示/隐藏桌宠",
    shortcutLabelPermissionAllow: "权限：允许",
    shortcutLabelPermissionDeny: "权限：拒绝",
    shortcutToastSaved: "快捷键已更新",
    sidebarSoon: "待推出",
    sectionAppearance: "外观",
    sectionStartup: "启动",
    sectionBubbles: "气泡",
    agentsTitle: "Agent 管理",
    agentsSubtitle: "按 agent 类型开关追踪。关闭后会停掉日志监视器、在 HTTP 入口丢弃 hook 事件——不会再驱动桌宠、不弹权限气泡、不记会话。",
    agentsEmpty: "没有已注册的 agent。",
    eventSourceHook: "Hook",
    eventSourceLogPoll: "日志轮询",
    eventSourcePlugin: "插件",
    badgePermissionBubble: "权限气泡",
    rowAgentPermissions: "显示弹窗",
    rowAgentPermissionsDesc: "关闭后让该 agent 在自己的终端里处理提示，不再弹 Clawd 气泡。",
    rowLanguage: "语言",
    rowLanguageDesc: "菜单和气泡的界面语言。",
    rowSound: "音效",
    rowSoundDesc: "Clawd 完成任务或需要输入时播放提示音。",
    rowOpenAtLogin: "开机自启",
    rowOpenAtLoginDesc: "登录系统时自动启动 Clawd。",
    rowManageClaudeHooks: "自动管理 Claude hooks",
    rowManageClaudeHooksDesc: "启动时同步 Claude hooks，并在 `~/.claude/settings.json` 被其他工具覆盖后自动补回。",
    rowManageClaudeHooksOffNote: "关闭后只会停止后续自动管理。当前已安装的 Claude hooks 会保留，除非你主动断开。",
    actionDisconnectClaudeHooks: "断开",
    rowStartWithClaude: "随 Claude Code 启动",
    rowStartWithClaudeDesc: "Claude Code 会话开始时自动拉起 Clawd。",
    rowStartWithClaudeDisabledDesc: "需要先开启 Claude hooks 自动管理。关闭期间，端口变化和外部覆盖都不会被自动修补。",
    rowBubbleFollow: "气泡跟随 Clawd",
    rowBubbleFollowDesc: "把权限气泡和更新气泡放在桌宠旁边，而不是屏幕角落。",
    rowHideBubbles: "隐藏所有气泡",
    rowHideBubblesDesc: "完全屏蔽权限、通知和更新气泡。",
    rowShowSessionId: "显示会话 ID",
    rowShowSessionIdDesc: "在气泡标题和会话菜单后追加短会话 ID。",
    rowAllowEdgePinning: "允许贴靠屏幕边缘",
    rowAllowEdgePinningDesc: "开启后桌宠贴屏幕边缘时，顶/底装饰（花花、建筑、气泡等）可能被裁掉。",
    rowSize: "大小",
    rowSizeDesc: "拖动调整桌宠大小。",
    placeholderTitle: "即将推出",
    placeholderDesc: "此面板将在 Clawd 后续版本中加入，规划见 docs/plans/plan-settings-panel.md。",
    toastSaveFailed: "保存失败：",
    langEnglish: "English",
    langChinese: "中文",
    langKorean: "한국어",
    themeTitle: "主题",
    themeSubtitle: "为 Clawd 选择一个主题。卡片会显示内建和能力角标，切换前就能看出 tracked / static / mini 等差异。",
    themeEmpty: "没有可用的主题。",
    themeBadgeBuiltin: "内建",
    themeBadgeActive: "当前",
    themeCapabilityTracked: "跟随 idle",
    themeCapabilityAnimated: "动画 idle",
    themeCapabilityStatic: "静态主题",
    themeCapabilityMini: "Mini",
    themeCapabilityDirectSleep: "直睡",
    themeCapabilityNoReactions: "无反应",
    themeActiveIndicator: "\u2713 当前",
    themeThumbMissing: "\u{1F3AD}",
    themeDeleteLabel: "删除主题",
    themeVariantStripLabel: "变体",
    toastThemeDeleted: "主题已删除。",
    toastThemeDeleteFailed: "删除主题失败：",
    animMapTitle: "动画映射",
    animMapSubtitle: "关掉不想看的打扰动画。事件照样会触发——Clawd 只是不再播放对应的动画和音效。",
    animMapSemanticsNote: "关闭 = 不播动画 + 不响音效。权限气泡、会话记录、终端聚焦照常工作。",
    animMapResetAll: "全部恢复",
    animMapAttentionLabel: "完成提示（happy）",
    animMapAttentionDesc: "Agent 结束一轮时的开心跳动（Stop / PostCompact）。",
    animMapErrorLabel: "错误提示",
    animMapErrorDesc: "工具调用失败时的抖动动画。",
    animMapSweepingLabel: "上下文清理",
    animMapSweepingDesc: "PreCompact / 清空上下文时的扫把动画。",
    animMapNotificationLabel: "通知提示",
    animMapNotificationDesc: "权限请求、消息询问时的铃铛动画。",
    animMapCarryingLabel: "Worktree 搬运",
    animMapCarryingDesc: "创建 worktree 时的搬运动画。",
    toastAnimMapResetOk: "动画覆盖已清空。",
    animOverridesTitle: "动画替换",
    animOverridesSubtitle: "按卡片换文件，并调整当前主题的淡入淡出与返回时机。",
    animOverridesCurrentTheme: "当前主题",
    animOverridesOpenThemeTab: "打开主题页",
    animOverridesOpenAssets: "打开素材目录",
    animOverridesResetAll: "全部恢复默认",
    animOverridesExport: "导出…",
    animOverridesImport: "导入…",
    toastAnimOverridesExportOk: (count, path) => `已导出 ${count} 个主题的覆盖 → ${path}`,
    toastAnimOverridesImportOk: (count) => `已导入 ${count} 个主题的覆盖。`,
    toastAnimOverridesExportEmpty: "当前没有覆盖可导出。",
    toastAnimOverridesExportFailed: (message) => `导出失败：${message}`,
    toastAnimOverridesImportFailed: (message) => `导入失败：${message}`,
    animOverridesChangeFile: "换文件",
    animOverridesPreview: "预览一次",
    animOverridesReset: "恢复槽位",
    animOverridesFade: "Fade",
    animOverridesFadeIn: "入",
    animOverridesFadeOut: "出",
    animOverridesSaveFade: "保存 Fade",
    animOverridesDuration: "返回时长",
    animOverridesSaveDuration: "保存时长",
    animOverridesContinuousHint: "持续态不提供 auto-return 编辑。",
    animOverridesAssetCycle: "素材周期",
    animOverridesSuggestedTiming: "建议时长",
    animOverridesTimingEstimated: "估算",
    animOverridesTimingFallback: "主题默认值",
    animOverridesTimingUnavailable: "不可用",
    animOverridesDisplayHintWarning: "运行时可能被 displayHintMap 盖掉。",
    animOverridesFallbackHint: "这个槽位当前回退到 {state}。",
    animOverridesOverriddenTooltip: "已修改（非默认值）",
    animOverridesUseOwnFile: "使用独立素材",
    animOverridesDurationIdle: "驻留时长",
    animOverridesSectionIdle: "Idle",
    animOverridesSectionWork: "工作态",
    animOverridesSectionInterrupts: "打扰态",
    animOverridesSectionSleep: "睡眠",
    animOverridesSectionMini: "Mini Mode",
    animOverridesSectionReactions: "反应动画",
    animOverridesSectionIdleTracked: "跟随鼠标的 idle",
    animOverridesSectionIdleAnimated: "idle 随机池",
    animOverridesSectionIdleStatic: "单张静态 idle",
    animOverridesSectionSleepFull: "完整睡眠序列",
    animOverridesSectionSleepDirect: "直睡模式",
    animReactionDrag: "拖拽（按住）",
    animReactionClickLeft: "戳（左）",
    animReactionClickRight: "戳（右）",
    animReactionAnnoyed: "烦躁（连续戳）",
    animReactionDouble: "双击",
    animOverridesWideHitboxToggle: "宽点击区",
    animOverridesWideHitboxDesc: "给这一帧启用更宽的点击区。素材视觉延伸超出默认桌宠轮廓时有用。",
    animOverridesWideHitboxResetToTheme: "恢复主题默认",
    animOverridesAspectWarning: "此素材宽高比与原文件差了 {pct}%，点击区和位置可能需要手动校准。",
    animOverridesExpandRow: "展开",
    animOverridesModalTitle: "选择素材文件",
    animOverridesModalSubtitle: "把文件放进当前主题 assets 目录后，可在这里刷新列表重新选择。",
    animOverridesModalEmpty: "当前主题里还没有可用素材。",
    animOverridesModalSelected: "当前选中",
    animOverridesModalUse: "使用这个文件",
    animOverridesModalCancel: "取消",
    animOverridesRefresh: "刷新列表",
    aboutTitle: "关于 Clawd",
    aboutSubtitle: "陪你写代码的像素螃蟹。",
    aboutTagline: "陪你 AI 编码的桌面伙伴。",
    aboutVersionLabel: "版本",
    aboutCheckForUpdates: "检查更新",
    aboutRepositoryLabel: "代码仓库",
    aboutLicenseLabel: "开源协议",
    aboutAuthorLabel: "作者",
    aboutContributorsLabel: "贡献者",
    aboutContributorsShowAll: "展开全部",
    aboutContributorsHide: "收起",
    aboutFooter: "Clawd 是开源项目 · 与社区一起打造。",
    aboutEasterEggToast: "\u{1F980} Coding shouldn't feel lonely. — Ruller_Lulu / \u9e7f\u9e7f",
    aboutOpenExternalFailed: "无法在浏览器中打开链接。",
  },
  ko: {
    settingsTitle: "설정",
    settingsSubtitle: "데스크톱에서 Clawd의 동작 방식을 설정합니다.",
    sidebarGeneral: "일반",
    sidebarAgents: "에이전트",
    sidebarTheme: "테마",
    sidebarAnimMap: "애니메이션 맵",
    sidebarAnimOverrides: "애니메이션 오버라이드",
    sidebarShortcuts: "단축키",
    sidebarAbout: "정보",
    shortcutsTitle: "단축키",
    shortcutsSubtitle: "펫 표시 전환과 권한 동작에 사용할 전역 단축키를 설정합니다. 비워 두면 해제됩니다.",
    shortcutRecordButton: "변경",
    shortcutClearButton: "해제",
    shortcutResetButton: "기본값 복원",
    shortcutResetAllButton: "모두 기본값 복원",
    shortcutRecordingHint: "키 조합 (Esc)",
    shortcutUnassigned: "— 미지정 —",
    shortcutErrorConflict: "{other} 와(과) 충돌합니다. 다른 키를 사용해 주세요.",
    shortcutErrorSystemConflict: "시스템 또는 다른 앱이 이미 사용 중입니다.",
    shortcutErrorReserved: "예약된 단축키 조합입니다. 다른 키를 사용해 주세요.",
    shortcutErrorInvalid: "지원하지 않는 키 조합입니다.",
    shortcutErrorNeedsModifier: "단축키에는 하나 이상의 보조 키가 필요합니다.",
    shortcutErrorRegistrationFailed: "저장되었지만 현재는 시스템 충돌로 활성화되지 않았습니다. 다시 바인딩하거나 나중에 다시 시도해 주세요.",
    shortcutLabelTogglePet: "펫 표시 전환",
    shortcutLabelPermissionAllow: "권한: 허용",
    shortcutLabelPermissionDeny: "권한: 거부",
    shortcutToastSaved: "단축키가 업데이트되었습니다",
    sidebarSoon: "예정",
    sectionAppearance: "외관",
    sectionStartup: "시작",
    sectionBubbles: "말풍선",
    agentsTitle: "에이전트",
    agentsSubtitle: "에이전트별로 추적을 켜거나 끕니다. 비활성화된 에이전트는 로그 모니터를 멈추고 HTTP 경계에서 hook 이벤트를 버리므로, 펫을 움직이거나 권한 말풍선을 띄우거나 세션을 유지하지 않습니다.",
    agentsEmpty: "등록된 에이전트가 없습니다.",
    eventSourceHook: "훅",
    eventSourceLogPoll: "로그 폴링",
    eventSourcePlugin: "플러그인",
    badgePermissionBubble: "권한 말풍선",
    rowAgentPermissions: "팝업 말풍선 표시",
    rowAgentPermissionsDesc: "끄면 이 에이전트는 Clawd 말풍선 대신 자체 터미널에서 프롬프트를 처리합니다.",
    rowLanguage: "언어",
    rowLanguageDesc: "메뉴와 말풍선의 인터페이스 언어입니다.",
    rowSound: "효과음",
    rowSoundDesc: "Clawd가 작업을 마치거나 입력을 요청할 때 알림음을 재생합니다.",
    rowOpenAtLogin: "로그인 시 자동 실행",
    rowOpenAtLoginDesc: "로그인할 때 Clawd를 자동으로 시작합니다.",
    rowManageClaudeHooks: "Claude hooks 자동 관리",
    rowManageClaudeHooksDesc: "시작 시 Claude hooks를 동기화하고 `~/.claude/settings.json`이 덮어써지면 다시 복구합니다.",
    rowManageClaudeHooksOffNote: "이 옵션을 꺼도 이후 자동 관리만 중지됩니다. 기존 Claude hooks는 직접 연결 해제하기 전까지 남아 있습니다.",
    actionDisconnectClaudeHooks: "연결 해제",
    rowStartWithClaude: "Claude Code와 함께 시작",
    rowStartWithClaudeDesc: "Claude Code 세션이 시작될 때마다 Clawd를 자동으로 실행합니다.",
    rowStartWithClaudeDisabledDesc: "Claude hooks 자동 관리가 필요합니다. 관리가 꺼져 있는 동안에는 포트 변경이나 설정 덮어쓰기를 자동으로 복구하지 않습니다.",
    rowBubbleFollow: "말풍선이 Clawd를 따라다님",
    rowBubbleFollowDesc: "권한 및 업데이트 말풍선을 화면 구석 대신 펫 옆에 표시합니다.",
    rowHideBubbles: "모든 말풍선 숨기기",
    rowHideBubblesDesc: "권한, 알림, 업데이트 말풍선을 모두 숨깁니다.",
    rowShowSessionId: "세션 ID 표시",
    rowShowSessionIdDesc: "말풍선 제목과 Sessions 메뉴에 짧은 세션 ID를 덧붙입니다.",
    rowAllowEdgePinning: "화면 가장자리에 붙이기 허용",
    rowAllowEdgePinningDesc: "화면 가장자리에 붙을 때 상/하단 장식(반짝임·건물·말풍선 등)이 잘릴 수 있습니다.",
    rowSize: "크기",
    rowSizeDesc: "드래그하여 펫 크기를 조절하세요.",
    placeholderTitle: "곧 제공 예정",
    placeholderDesc: "이 패널은 향후 Clawd 릴리스에 추가됩니다. 계획은 docs/plans/plan-settings-panel.md에 있습니다.",
    toastSaveFailed: "저장 실패: ",
    langEnglish: "English",
    langChinese: "中文",
    langKorean: "한국어",
    themeTitle: "테마",
    themeSubtitle: "Clawd의 테마를 선택합니다. 카드에는 기본 제공/능력 배지가 표시되어 tracked/static/mini 차이를 미리 볼 수 있습니다.",
    themeEmpty: "사용 가능한 테마가 없습니다.",
    themeBadgeBuiltin: "기본 제공",
    themeBadgeActive: "활성",
    themeCapabilityTracked: "커서 추적 idle",
    themeCapabilityAnimated: "애니메이션 idle",
    themeCapabilityStatic: "정적 테마",
    themeCapabilityMini: "Mini",
    themeCapabilityDirectSleep: "직접 수면",
    themeCapabilityNoReactions: "반응 없음",
    themeActiveIndicator: "\u2713 활성",
    themeThumbMissing: "\u{1F3AD}",
    themeDeleteLabel: "테마 삭제",
    themeVariantStripLabel: "변형",
    toastThemeDeleted: "테마를 삭제했습니다.",
    toastThemeDeleteFailed: "테마 삭제 실패: ",
    animMapTitle: "애니메이션 맵",
    animMapSubtitle: "개별 인터럽트 애니메이션을 끕니다. 이벤트는 계속 발생하지만 Clawd는 선택한 상태의 화면과 소리만 건너뜁니다.",
    animMapSemanticsNote: "비활성화 = 화면 없음 + 소리 없음. 권한 말풍선, 세션, 터미널 포커스는 그대로 작동합니다.",
    animMapResetAll: "모두 초기화",
    animMapAttentionLabel: "작업 완료 (happy)",
    animMapAttentionDesc: "에이전트가 한 턴을 마쳤을 때 재생되는 즐거운 바운스 애니메이션입니다. (Stop / PostCompact)",
    animMapErrorLabel: "오류 플래시",
    animMapErrorDesc: "도구 호출이 실패했을 때 흔들리는 애니메이션입니다.",
    animMapSweepingLabel: "컨텍스트 정리",
    animMapSweepingDesc: "PreCompact / 컨텍스트 정리 중 빗자루 애니메이션입니다.",
    animMapNotificationLabel: "알림",
    animMapNotificationDesc: "권한 요청과 입력 요청 시 재생되는 종 애니메이션입니다.",
    animMapCarryingLabel: "워크트리 운반",
    animMapCarryingDesc: "worktree가 생성될 때 재생되는 운반 애니메이션입니다.",
    toastAnimMapResetOk: "애니메이션 오버라이드를 초기화했습니다.",
    animOverridesTitle: "애니메이션 오버라이드",
    animOverridesSubtitle: "현재 테마의 카드별 파일을 바꾸고 페이드/복귀 타이밍을 조정합니다.",
    animOverridesCurrentTheme: "현재 테마",
    animOverridesOpenThemeTab: "테마 탭 열기",
    animOverridesOpenAssets: "assets 폴더 열기",
    animOverridesResetAll: "모두 기본값으로 복원",
    animOverridesExport: "내보내기…",
    animOverridesImport: "가져오기…",
    toastAnimOverridesExportOk: (count, path) => `${count}개 테마 덮어쓰기를 내보냈습니다 → ${path}`,
    toastAnimOverridesImportOk: (count) => `${count}개 테마 덮어쓰기를 가져왔습니다.`,
    toastAnimOverridesExportEmpty: "내보낼 덮어쓰기가 없습니다.",
    toastAnimOverridesExportFailed: (message) => `내보내기 실패: ${message}`,
    toastAnimOverridesImportFailed: (message) => `가져오기 실패: ${message}`,
    animOverridesChangeFile: "파일 변경",
    animOverridesPreview: "한 번 미리보기",
    animOverridesReset: "슬롯 초기화",
    animOverridesFade: "페이드",
    animOverridesFadeIn: "입장",
    animOverridesFadeOut: "퇴장",
    animOverridesSaveFade: "페이드 저장",
    animOverridesDuration: "자동 복귀",
    animOverridesSaveDuration: "타이밍 저장",
    animOverridesContinuousHint: "지속 상태는 여기서 auto-return을 편집할 수 없습니다.",
    animOverridesAssetCycle: "에셋 주기",
    animOverridesSuggestedTiming: "권장 타이밍",
    animOverridesTimingEstimated: "추정값",
    animOverridesTimingFallback: "테마 기본값",
    animOverridesTimingUnavailable: "사용할 수 없음",
    animOverridesDisplayHintWarning: "displayHintMap이 런타임에 이 슬롯을 덮어쓸 수 있습니다.",
    animOverridesFallbackHint: "이 슬롯은 현재 {state}(으)로 폴백됩니다.",
    animOverridesOverriddenTooltip: "기본값에서 변경됨",
    animOverridesUseOwnFile: "개별 파일 사용",
    animOverridesDurationIdle: "유지 시간",
    animOverridesSectionIdle: "Idle",
    animOverridesSectionWork: "작업",
    animOverridesSectionInterrupts: "인터럽트",
    animOverridesSectionSleep: "수면",
    animOverridesSectionMini: "Mini Mode",
    animOverridesSectionReactions: "반응 애니메이션",
    animOverridesSectionIdleTracked: "커서 추적 idle",
    animOverridesSectionIdleAnimated: "idle 랜덤 풀",
    animOverridesSectionIdleStatic: "단일 정적 idle",
    animOverridesSectionSleepFull: "전체 수면 시퀀스",
    animOverridesSectionSleepDirect: "직접 수면",
    animReactionDrag: "드래그 (누름)",
    animReactionClickLeft: "콕 찌르기 (왼쪽)",
    animReactionClickRight: "콕 찌르기 (오른쪽)",
    animReactionAnnoyed: "짜증 (연속 찌르기)",
    animReactionDouble: "더블탭",
    animOverridesWideHitboxToggle: "넓은 클릭 영역",
    animOverridesWideHitboxDesc: "이 프레임에 더 넓은 클릭 영역을 사용합니다. 애셋이 기본 펫 실루엣을 넘어설 때 유용합니다.",
    animOverridesWideHitboxResetToTheme: "테마 기본값으로 복원",
    animOverridesAspectWarning: "이 애셋의 가로세로 비율이 원본과 {pct}% 차이납니다. 클릭 영역과 위치를 수동으로 조정해야 할 수 있습니다.",
    animOverridesExpandRow: "펼치기",
    animOverridesModalTitle: "에셋 파일 선택",
    animOverridesModalSubtitle: "파일을 현재 테마의 assets 폴더에 추가한 뒤 여기서 목록을 새로고침하세요.",
    animOverridesModalEmpty: "이 테마에는 아직 지원되는 에셋이 없습니다.",
    animOverridesModalSelected: "선택된 파일",
    animOverridesModalUse: "이 파일 사용",
    animOverridesModalCancel: "취소",
    animOverridesRefresh: "목록 새로고침",
    aboutTitle: "Clawd 정보",
    aboutSubtitle: "당신의 AI 코딩 세션을 지켜보는 픽셀 게.",
    aboutTagline: "AI 코딩 여정을 함께하는 데스크톱 동반자.",
    aboutVersionLabel: "버전",
    aboutCheckForUpdates: "업데이트 확인",
    aboutRepositoryLabel: "저장소",
    aboutLicenseLabel: "라이선스",
    aboutAuthorLabel: "제작",
    aboutContributorsLabel: "기여자",
    aboutContributorsShowAll: "모두 보기",
    aboutContributorsHide: "접기",
    aboutFooter: "Clawd는 오픈 소스 · 커뮤니티와 함께 만듭니다.",
    aboutEasterEggToast: "\u{1F980} Coding shouldn't feel lonely. — Ruller_Lulu / \u9e7f\u9e7f",
    aboutOpenExternalFailed: "링크를 브라우저에서 열 수 없습니다.",
  },
};

// Contributors list (README order, hardcoded — update when new contributors land).
// GitHub usernames don't translate, so this is shared across all locales.
const CONTRIBUTORS = [
  "PixelCookie-zyf", "yujiachen-y", "AooooooZzzz", "purefkh", "Tobeabellwether", "Jasonhonghh", "crashchen",
  "hongbigtou", "InTimmyDate", "NeizhiTouhu", "xu3stones-cmd", "androidZzT", "Ye-0413", "WanfengzzZ",
  "TaoXieSZ", "ssly", "stickycandy", "Rladmsrl", "YOIMIYA66", "Kevin7Qi", "sefuzhou770801-hub",
  "Tonic-Jin", "seoki180", "PeterShanxin", "rullerzhou-afk", "CHIANGANGSTER",
];

const SHORTCUT_API = globalThis.ClawdShortcutActions || {};
const SHORTCUT_ACTIONS = SHORTCUT_API.SHORTCUT_ACTIONS || {};
const SHORTCUT_ACTION_IDS = SHORTCUT_API.SHORTCUT_ACTION_IDS || Object.keys(SHORTCUT_ACTIONS);
const buildAcceleratorFromEvent = SHORTCUT_API.buildAcceleratorFromEvent
  || (() => ({ action: "reject", reason: "That key combination is not supported." }));
const formatAcceleratorLabel = SHORTCUT_API.formatAcceleratorLabel
  || ((value) => value || "— unassigned —");
const formatAcceleratorPartial = SHORTCUT_API.formatAcceleratorPartial
  || (() => "");
const IS_MAC = /\bMac\b/i.test(navigator.platform || "");

let snapshot = null;
let activeTab = "general";
// Static per-agent metadata from agents/registry.js via settings:list-agents.
// Fetched once at boot (since it can't change while the app is running).
// Null until hydrated — renderAgentsTab() renders an empty placeholder.
let agentMetadata = null;

// Theme list cache. Unlike agents, this CAN change at runtime (user deletes
// a theme, drops a new one into the folder). Null until first fetch; refreshed
// on tab open, after removeTheme succeeds, and on `theme` broadcasts.
let themeList = null;
let animationOverridesData = null;
let assetPickerState = null;
let assetPickerPollTimer = null;
const expandedOverrideRowIds = new Set();
let shortcutFailures = {};
let shortcutFailureToastShown = false;
let shortcutRecordingActionId = null;
let shortcutRecordingError = "";
let shortcutRecordingPartial = [];
let nextTransientUiSeq = 1;

const GENERAL_IN_PLACE_KEYS = new Set([
  "size",
  "soundMuted",
  "allowEdgePinning",
  "openAtLogin",
  "autoStartWithClaude",
  "bubbleFollowPet",
  "hideBubbles",
  "showSessionId",
]);

const transientUiState = {
  generalSwitches: new Map(),
  agentSwitches: new Map(),
  size: {
    draftUi: null,
    dragging: false,
    pending: false,
    seq: 0,
  },
};

const mountedControls = {
  generalSwitches: new Map(),
  agentSwitches: new Map(),
  size: null,
};

function clearMountedControls() {
  if (mountedControls.size && typeof mountedControls.size.dispose === "function") {
    Promise.resolve(mountedControls.size.dispose()).catch(() => {});
  }
  mountedControls.generalSwitches.clear();
  mountedControls.agentSwitches.clear();
  mountedControls.size = null;
}

function readSizeUiFromSnapshot() {
  const value = snapshot && snapshot.size;
  if (typeof value === "string" && value.startsWith("P:")) {
    const parsed = parseFloat(value.slice(2));
    if (Number.isFinite(parsed) && parsed > 0) return clampSizeUi(prefsSizeToUi(parsed));
  }
  return clampSizeUi(prefsSizeToUi(10));
}

function readGeneralSwitchRaw(key) {
  return !!(snapshot && snapshot[key]);
}

function readGeneralSwitchVisual(key, invert = false) {
  const rawValue = readGeneralSwitchRaw(key);
  return invert ? !rawValue : rawValue;
}

function agentSwitchStateId(agentId, flag) {
  return `${agentId}:${flag}`;
}

function readAgentFlagValue(agentId, flag) {
  const entry = snapshot && snapshot.agents && snapshot.agents[agentId];
  return entry ? entry[flag] !== false : true;
}

function setSwitchVisual(sw, visualOn, { pending = false } = {}) {
  sw.classList.toggle("on", !!visualOn);
  sw.classList.toggle("pending", !!pending);
  sw.setAttribute("aria-checked", visualOn ? "true" : "false");
}

function attachAnimatedSwitch(sw, { getCommittedVisual, getTransientState, setTransientState, clearTransientState, invoke }) {
  const run = () => {
    if (sw.classList.contains("pending")) return;
    const currentVisual = getCommittedVisual();
    const nextVisual = !currentVisual;
    const seq = nextTransientUiSeq++;
    setTransientState({ visualOn: nextVisual, pending: true, seq });
    setSwitchVisual(sw, nextVisual, { pending: true });
    Promise.resolve()
      .then(invoke)
      .then((result) => {
        const current = getTransientState();
        if (!current || current.seq !== seq) return;
        if (!result || result.status !== "ok" || result.noop) {
          clearTransientState(seq);
          setSwitchVisual(sw, getCommittedVisual(), { pending: false });
          if (result && result.noop) return;
          const msg = (result && result.message) || "unknown error";
          showToast(t("toastSaveFailed") + msg, { error: true });
          return;
        }
        setTransientState({ visualOn: nextVisual, pending: false, seq });
        setSwitchVisual(sw, nextVisual, { pending: false });
      })
      .catch((err) => {
        const current = getTransientState();
        if (!current || current.seq !== seq) return;
        clearTransientState(seq);
        setSwitchVisual(sw, getCommittedVisual(), { pending: false });
        showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      });
  };
  sw.addEventListener("click", run);
  sw.addEventListener("keydown", (ev) => {
    if (ev.key === " " || ev.key === "Enter") {
      ev.preventDefault();
      run();
    }
  });
}

function syncMountedSizeControl({ fromBroadcast = false } = {}) {
  const control = mountedControls.size;
  if (!control || !document.body.contains(control.row)) return false;
  control.syncFromSnapshot({ fromBroadcast });
  return true;
}

function tryPatchActiveTabInPlace(changes) {
  const keys = changes ? Object.keys(changes) : [];
  if (keys.length === 0) return false;

  if (activeTab === "general") {
    if (!keys.every((key) => GENERAL_IN_PLACE_KEYS.has(key))) return false;
    if (keys.includes("size") && !syncMountedSizeControl({ fromBroadcast: true })) return false;
    for (const key of keys) {
      if (key === "size") continue;
      const meta = mountedControls.generalSwitches.get(key);
      if (!meta || !document.body.contains(meta.element)) return false;
    }
    for (const key of keys) {
      if (key === "size") continue;
      const meta = mountedControls.generalSwitches.get(key);
      transientUiState.generalSwitches.delete(key);
      setSwitchVisual(meta.element, readGeneralSwitchVisual(key, meta.invert), { pending: false });
    }
    return true;
  }

  if (activeTab === "agents") {
    if (!(keys.length === 1 && keys[0] === "agents")) return false;
    if (mountedControls.agentSwitches.size === 0) return false;
    for (const [id, meta] of mountedControls.agentSwitches) {
      if (!meta || !document.body.contains(meta.element)) return false;
      transientUiState.agentSwitches.delete(id);
      setSwitchVisual(meta.element, readAgentFlagValue(meta.agentId, meta.flag), { pending: false });
    }
    return true;
  }

  return false;
}

function t(key) {
  const lang = (snapshot && snapshot.lang) || "en";
  const dict = STRINGS[lang] || STRINGS.en;
  return dict[key] || key;
}

// ── Toast ──
const toastStack = document.getElementById("toastStack");
function showToast(message, { error = false, ttl = 3500 } = {}) {
  const node = document.createElement("div");
  node.className = "toast" + (error ? " error" : "");
  node.textContent = message;
  toastStack.appendChild(node);
  // Force reflow then add visible class so the transition runs.
  // eslint-disable-next-line no-unused-expressions
  node.offsetHeight;
  node.classList.add("visible");
  setTimeout(() => {
    node.classList.remove("visible");
    setTimeout(() => node.remove(), 240);
  }, ttl);
}

// ── Sidebar ──
const SIDEBAR_TABS = [
  { id: "general", icon: "\u2699", labelKey: "sidebarGeneral", available: true },
  { id: "agents", icon: "\u26A1", labelKey: "sidebarAgents", available: true },
  { id: "theme", icon: "\u{1F3A8}", labelKey: "sidebarTheme", available: true },
  { id: "animMap", icon: "\u{1F3AC}", labelKey: "sidebarAnimMap", available: true },
  { id: "animOverrides", icon: "\u{1F39E}", labelKey: "sidebarAnimOverrides", available: true },
  { id: "shortcuts", icon: "\u2328", labelKey: "sidebarShortcuts", available: true },
  { id: "about", icon: "\u2139", labelKey: "sidebarAbout", available: true },
];

function renderSidebar() {
  const sidebar = document.getElementById("sidebar");
  sidebar.innerHTML = "";
  for (const tab of SIDEBAR_TABS) {
    const item = document.createElement("div");
    item.className = "sidebar-item";
    if (!tab.available) item.classList.add("disabled");
    if (tab.id === activeTab) item.classList.add("active");
    item.innerHTML =
      `<span class="sidebar-item-icon">${tab.icon}</span>` +
      `<span class="sidebar-item-label">${escapeHtml(t(tab.labelKey))}</span>` +
      (tab.available ? "" : `<span class="sidebar-item-soon">${escapeHtml(t("sidebarSoon"))}</span>`);
    if (tab.available) {
      item.addEventListener("click", () => {
        activeTab = tab.id;
        renderSidebar();
        renderContent();
      });
    }
    sidebar.appendChild(item);
  }
}

// ── Content ──
function renderContent() {
  const content = document.getElementById("content");
  if (activeTab !== "animOverrides" && assetPickerState) closeAssetPicker();
  clearMountedControls();
  content.innerHTML = "";
  if (activeTab === "general") {
    renderGeneralTab(content);
  } else if (activeTab === "agents") {
    renderAgentsTab(content);
  } else if (activeTab === "theme") {
    renderThemeTab(content);
  } else if (activeTab === "animMap") {
    renderAnimMapTab(content);
  } else if (activeTab === "animOverrides") {
    renderAnimOverridesTab(content);
  } else if (activeTab === "shortcuts") {
    renderShortcutsTab(content);
  } else if (activeTab === "about") {
    renderAboutTab(content);
  } else {
    renderPlaceholder(content);
  }
}

// ── Animation Map tab (Phase 3b — Disable-only) ──

// 每行一个 oneshot state。顺序影响 UI 排列——按优先级从高到低。
const ANIM_MAP_ROWS = [
  { stateKey: "error",        labelKey: "animMapErrorLabel",        descKey: "animMapErrorDesc" },
  { stateKey: "notification", labelKey: "animMapNotificationLabel", descKey: "animMapNotificationDesc" },
  { stateKey: "sweeping",     labelKey: "animMapSweepingLabel",     descKey: "animMapSweepingDesc" },
  { stateKey: "attention",    labelKey: "animMapAttentionLabel",    descKey: "animMapAttentionDesc" },
  { stateKey: "carrying",     labelKey: "animMapCarryingLabel",     descKey: "animMapCarryingDesc" },
];

function renderAnimMapTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("animMapTitle");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("animMapSubtitle");
  parent.appendChild(subtitle);

  const note = document.createElement("p");
  note.className = "subtitle";
  note.textContent = t("animMapSemanticsNote");
  parent.appendChild(note);

  const themeId = (snapshot && snapshot.theme) || "clawd";
  const rows = ANIM_MAP_ROWS.map((spec) => buildAnimMapRow(spec, themeId));
  parent.appendChild(buildSection("", rows));

  const hasAny = readThemeOverrideMap(themeId) !== null;
  const resetWrap = document.createElement("div");
  resetWrap.className = "anim-map-reset";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "theme-delete-btn anim-map-reset-btn";
  resetBtn.textContent = t("animMapResetAll");
  if (!hasAny) resetBtn.disabled = true;
  attachActivation(resetBtn, () =>
    window.settingsAPI.command("resetThemeOverrides", { themeId })
      .then((result) => {
        if (result && result.status === "ok" && !result.noop) {
          showToast(t("toastAnimMapResetOk"));
        }
        return result;
      })
  );
  resetWrap.appendChild(resetBtn);
  parent.appendChild(resetWrap);
}

function readThemeOverrideMap(themeId) {
  const all = snapshot && snapshot.themeOverrides;
  const map = all && all[themeId];
  if (!map || typeof map !== "object") return null;
  const keys = [
    ...(map.states ? Object.keys(map.states) : []),
    ...(map.tiers && map.tiers.workingTiers ? Object.keys(map.tiers.workingTiers) : []),
    ...(map.tiers && map.tiers.jugglingTiers ? Object.keys(map.tiers.jugglingTiers) : []),
    ...(map.timings && map.timings.autoReturn ? Object.keys(map.timings.autoReturn) : []),
  ];
  return keys.length > 0 ? map : null;
}

function isStateDisabled(themeId, stateKey) {
  const map = readThemeOverrideMap(themeId);
  const states = map && map.states;
  const entry = (states && states[stateKey]) || (map && map[stateKey]);
  return !!(entry && entry.disabled === true);
}

function buildAnimMapRow(spec, themeId) {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML =
    `<div class="row-text">` +
      `<span class="row-label"></span>` +
      `<span class="row-desc"></span>` +
    `</div>` +
    `<div class="row-control"><div class="switch" role="switch" tabindex="0"></div></div>`;
  row.querySelector(".row-label").textContent = t(spec.labelKey);
  row.querySelector(".row-desc").textContent = t(spec.descKey);
  const sw = row.querySelector(".switch");

  const disabled = isStateDisabled(themeId, spec.stateKey);
  const visualOn = !disabled; // ON = 动画启用
  if (visualOn) sw.classList.add("on");
  sw.setAttribute("aria-checked", visualOn ? "true" : "false");

  attachActivation(sw, () => {
    const nextDisabled = !isStateDisabled(themeId, spec.stateKey);
    return window.settingsAPI.command("setThemeOverrideDisabled", {
      themeId,
      stateKey: spec.stateKey,
      disabled: nextDisabled,
    });
  });
  return row;
}

// ── Theme tab ──

function fetchThemes() {
  if (!window.settingsAPI || typeof window.settingsAPI.listThemes !== "function") {
    themeList = [];
    return Promise.resolve([]);
  }
  return window.settingsAPI.listThemes().then((list) => {
    themeList = Array.isArray(list) ? list : [];
    return themeList;
  }).catch((err) => {
    console.warn("settings: listThemes failed", err);
    themeList = [];
    return [];
  });
}

function renderThemeTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("themeTitle");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("themeSubtitle");
  parent.appendChild(subtitle);

  if (themeList === null) {
    const loading = document.createElement("div");
    loading.className = "placeholder-desc";
    parent.appendChild(loading);
    fetchThemes().then(() => {
      if (activeTab === "theme") renderContent();
    });
    return;
  }

  if (themeList.length === 0) {
    const empty = document.createElement("div");
    empty.className = "placeholder";
    empty.innerHTML = `<div class="placeholder-desc">${escapeHtml(t("themeEmpty"))}</div>`;
    parent.appendChild(empty);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "theme-grid";
  for (const theme of themeList) {
    grid.appendChild(buildThemeCard(theme));
  }
  parent.appendChild(grid);
}

// Resolve an `{en, zh}` object or a plain string to a localized string.
// Falls back across languages before giving up.
function localizeField(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const lang = (snapshot && snapshot.lang) || "en";
    if (value[lang]) return value[lang];
    if (value.en) return value.en;
    if (value.zh) return value.zh;
    const firstKey = Object.keys(value)[0];
    if (firstKey) return value[firstKey];
  }
  return "";
}

// Target visual content size inside theme-thumb frames. Picked to match
// clawd's natural ratio (~0.51) so pixel pets stay full-size while
// tight-canvas themes like calico (~0.80) get scaled down to feel balanced.
const PREVIEW_TARGET_CONTENT_RATIO = 0.55;

function applyThemePreviewScale(img, contentRatio) {
  if (!Number.isFinite(contentRatio) || contentRatio <= 0) return;
  if (contentRatio <= PREVIEW_TARGET_CONTENT_RATIO) return;
  const scale = PREVIEW_TARGET_CONTENT_RATIO / contentRatio;
  const pct = `${(scale * 100).toFixed(2)}%`;
  img.style.maxWidth = pct;
  img.style.maxHeight = pct;
}

function applyThemePreviewOffset(img, offsetPct) {
  if (!offsetPct) return;
  const { x, y } = offsetPct;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return;
  img.style.transform = `translate(${x.toFixed(2)}%, ${y.toFixed(2)}%)`;
}

function getThemeCapabilityBadgeLabels(theme) {
  const caps = theme && theme.capabilities;
  if (!caps || typeof caps !== "object") return [];
  const badges = [];
  if (caps.idleMode === "tracked") badges.push(t("themeCapabilityTracked"));
  else if (caps.idleMode === "animated") badges.push(t("themeCapabilityAnimated"));
  else if (caps.idleMode === "static") badges.push(t("themeCapabilityStatic"));
  if (caps.miniMode) badges.push(t("themeCapabilityMini"));
  if (caps.sleepMode === "direct") badges.push(t("themeCapabilityDirectSleep"));
  if (caps.reactions === false) badges.push(t("themeCapabilityNoReactions"));
  return badges;
}

function buildThemeCard(theme) {
  const card = document.createElement("div");
  card.className = "theme-card";
  card.setAttribute("role", "radio");
  card.setAttribute("tabindex", "0");
  card.setAttribute("aria-checked", theme.active ? "true" : "false");
  if (theme.active) card.classList.add("active");

  const thumb = document.createElement("div");
  thumb.className = "theme-thumb";
  if (theme.previewFileUrl) {
    const img = document.createElement("img");
    img.src = theme.previewFileUrl;
    img.alt = "";
    img.draggable = false;
    applyThemePreviewScale(img, theme.previewContentRatio);
    applyThemePreviewOffset(img, theme.previewContentOffsetPct);
    thumb.appendChild(img);
  } else {
    const glyph = document.createElement("span");
    glyph.className = "theme-thumb-empty";
    glyph.textContent = t("themeThumbMissing");
    thumb.appendChild(glyph);
  }
  card.appendChild(thumb);

  const name = document.createElement("div");
  name.className = "theme-card-name";
  const nameText = document.createElement("span");
  nameText.className = "theme-card-name-text";
  nameText.textContent = theme.name || theme.id;
  name.appendChild(nameText);
  if (theme.builtin) {
    const badge = document.createElement("span");
    badge.className = "theme-card-badge";
    badge.textContent = t("themeBadgeBuiltin");
    name.appendChild(badge);
  }
  card.appendChild(name);

  const capLabels = getThemeCapabilityBadgeLabels(theme);
  if (capLabels.length) {
    const caps = document.createElement("div");
    caps.className = "theme-card-capabilities";
    for (const label of capLabels) {
      const badge = document.createElement("span");
      badge.className = "theme-card-badge";
      badge.textContent = label;
      caps.appendChild(badge);
    }
    card.appendChild(caps);
  }

  const canDelete = !theme.builtin && !theme.active;
  if (theme.active || canDelete) {
    const footer = document.createElement("div");
    footer.className = "theme-card-footer";
    const indicator = document.createElement("span");
    indicator.className = "theme-card-check";
    indicator.textContent = theme.active ? t("themeActiveIndicator") : "";
    footer.appendChild(indicator);
    if (canDelete) {
      const btn = document.createElement("button");
      btn.className = "theme-delete-btn";
      btn.type = "button";
      btn.textContent = "\u{1F5D1}";
      btn.title = t("themeDeleteLabel");
      btn.setAttribute("aria-label", t("themeDeleteLabel"));
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        handleDeleteTheme(theme);
      });
      footer.appendChild(btn);
    }
    card.appendChild(footer);
  }

  if (!theme.active) {
    // Phase 3b-swap: theme switches go through setThemeSelection so the
    // stored themeVariant[themeId] is honoured (or self-healed on dead ids).
    // applyUpdate("theme", id) would bypass the variant-resolution path.
    attachActivation(card, () => window.settingsAPI.command("setThemeSelection", { themeId: theme.id }));
  }
  return card;
}

function handleDeleteTheme(theme) {
  if (!window.settingsAPI) return;
  window.settingsAPI
    .confirmRemoveTheme(theme.id)
    .then((res) => {
      if (!res || !res.confirmed) return null;
      return window.settingsAPI.command("removeTheme", theme.id);
    })
    .then((result) => {
      if (result == null) return;
      if (result.status !== "ok") {
        const msg = (result && result.message) || "unknown error";
        showToast(t("toastThemeDeleteFailed") + msg, { error: true });
        return;
      }
      showToast(t("toastThemeDeleted"));
      fetchThemes().then(() => {
        if (activeTab === "theme") renderContent();
      });
    })
    .catch((err) => {
      showToast(t("toastThemeDeleteFailed") + (err && err.message), { error: true });
    });
}

function fetchAnimationOverridesData() {
  if (!window.settingsAPI || typeof window.settingsAPI.getAnimationOverridesData !== "function") {
    animationOverridesData = { theme: null, assets: [], cards: [] };
    return Promise.resolve(animationOverridesData);
  }
  return window.settingsAPI.getAnimationOverridesData().then((data) => {
    animationOverridesData = data || { theme: null, assets: [], cards: [] };
    return animationOverridesData;
  }).catch((err) => {
    console.warn("settings: getAnimationOverridesData failed", err);
    animationOverridesData = { theme: null, assets: [], cards: [] };
    return animationOverridesData;
  });
}

function getAnimOverrideCardById(cardId) {
  const cards = animationOverridesData && animationOverridesData.cards;
  return Array.isArray(cards) ? cards.find((card) => card.id === cardId) || null : null;
}

function getAnimationAssetsSignature(data = animationOverridesData) {
  const assets = data && Array.isArray(data.assets) ? data.assets : [];
  return assets.map((asset) => [
    asset.name,
    asset.cycleMs == null ? "" : asset.cycleMs,
    asset.cycleStatus || "",
  ].join(":")).join("\n");
}

function stopAssetPickerPolling() {
  if (assetPickerPollTimer) {
    clearInterval(assetPickerPollTimer);
    assetPickerPollTimer = null;
  }
}

function closeAssetPicker() {
  assetPickerState = null;
  stopAssetPickerPolling();
  renderAssetPickerModal();
}

function normalizeAssetPickerSelection() {
  if (!assetPickerState || !animationOverridesData) return;
  const assets = Array.isArray(animationOverridesData.assets) ? animationOverridesData.assets : [];
  if (!assets.length) {
    assetPickerState.selectedFile = null;
    return;
  }
  const stillExists = assets.some((asset) => asset.name === assetPickerState.selectedFile);
  if (!stillExists) assetPickerState.selectedFile = assets[0].name;
}

function captureAssetPickerScrollState() {
  if (!assetPickerState) return;
  const list = document.querySelector(".asset-picker-list");
  if (!list) return;
  assetPickerState.listScrollTop = list.scrollTop;
}

function restoreAssetPickerScrollState(list) {
  if (!list || !assetPickerState || typeof assetPickerState.listScrollTop !== "number") return;
  const target = assetPickerState.listScrollTop;
  list.scrollTop = target;
  requestAnimationFrame(() => {
    if (document.body.contains(list)) list.scrollTop = target;
  });
}

function shouldRefreshAssetPickerModal({ previousSignature, previousSelectedFile }) {
  if (!assetPickerState) return false;
  if (assetPickerState.selectedFile !== previousSelectedFile) return true;
  return getAnimationAssetsSignature() !== previousSignature;
}

function startAssetPickerPolling() {
  stopAssetPickerPolling();
  assetPickerPollTimer = setInterval(() => {
    if (!assetPickerState) return;
    const previousSignature = getAnimationAssetsSignature();
    const previousSelectedFile = assetPickerState.selectedFile;
    fetchAnimationOverridesData().then(() => {
      normalizeAssetPickerSelection();
      if (shouldRefreshAssetPickerModal({ previousSignature, previousSelectedFile })) {
        renderAssetPickerModal();
      }
    });
  }, 1500);
}

function previewStateForCard(card) {
  if (!card) return null;
  if (card.slotType === "tier") {
    return card.tierGroup === "jugglingTiers" ? "juggling" : "working";
  }
  if (card.slotType === "idleAnimation") return "idle";
  return card.stateKey;
}

function buildAnimOverrideRequest(card, patch) {
  const themeId = animationOverridesData && animationOverridesData.theme && animationOverridesData.theme.id;
  const base = {
    themeId,
    slotType: card.slotType,
  };
  if (card.slotType === "tier") {
    base.tierGroup = card.tierGroup;
    base.originalFile = card.originalFile;
  } else if (card.slotType === "idleAnimation") {
    base.originalFile = card.originalFile;
  } else if (card.slotType === "reaction") {
    base.reactionKey = card.reactionKey;
  } else {
    base.stateKey = card.stateKey;
  }
  return { ...base, ...patch };
}

function runAnimationOverrideCommand(card, patch) {
  const payload = buildAnimOverrideRequest(card, patch);
  return window.settingsAPI.command("setAnimationOverride", payload).then((result) => {
    if (!result || result.status !== "ok" || result.noop) return result;
    return fetchAnimationOverridesData().then(() => {
      normalizeAssetPickerSelection();
      if (activeTab === "animOverrides") renderContent();
      renderAssetPickerModal();
      return result;
    });
  });
}

function openAssetPicker(card) {
  assetPickerState = {
    cardId: card.id,
    selectedFile: card.currentFile,
  };
  renderAssetPickerModal();
  startAssetPickerPolling();
}

function formatSessionRange(minSessions, maxSessions) {
  const lang = (snapshot && snapshot.lang) || "en";
  if (lang === "zh") {
    if (maxSessions == null) return `${minSessions}+ 会话`;
    if (minSessions === maxSessions) return `${minSessions} 会话`;
    return `${minSessions}-${maxSessions} 会话`;
  }
  if (lang === "ko") {
    if (maxSessions == null) return `${minSessions}+ 세션`;
    if (minSessions === maxSessions) return `${minSessions} 세션`;
    return `${minSessions}-${maxSessions} 세션`;
  }
  if (maxSessions == null) return `${minSessions}+ sessions`;
  if (minSessions === maxSessions) return `${minSessions} session${minSessions === 1 ? "" : "s"}`;
  return `${minSessions}-${maxSessions} sessions`;
}

function getAnimOverrideTriggerLabel(card) {
  switch (card.triggerKind) {
    case "idleTracked": return "Idle follow";
    case "idleStatic": return "Idle";
    case "idleAnimation": return `Idle random #${card.poolIndex || 1}`;
    case "thinking": return "UserPromptSubmit";
    case "working": return `PreToolUse (${formatSessionRange(card.minSessions, card.maxSessions)})`;
    case "juggling": return `SubagentStart (${formatSessionRange(card.minSessions, card.maxSessions)})`;
    case "error": return "PostToolUseFailure";
    case "attention": return "Stop / PostCompact";
    case "notification": return "PermissionRequest";
    case "sweeping": return "PreCompact";
    case "carrying": return "WorktreeCreate";
    case "yawning": return "Sleep: yawn";
    case "dozing": return "Sleep: doze";
    case "collapsing": return "Sleep: collapse";
    case "sleeping": return "60s no events";
    case "waking": return "Wake";
    case "mini-idle": return "Mini idle";
    case "mini-enter": return "Mini enter";
    case "mini-enter-sleep": return "Mini enter sleep";
    case "mini-crabwalk": return "Mini crabwalk";
    case "mini-peek": return "Mini peek";
    case "mini-alert": return "Mini alert";
    case "mini-happy": return "Mini happy";
    case "mini-sleep": return "Mini sleep";
    case "dragReaction": return t("animReactionDrag");
    case "clickLeftReaction": return t("animReactionClickLeft");
    case "clickRightReaction": return t("animReactionClickRight");
    case "annoyedReaction": return t("animReactionAnnoyed");
    case "doubleReaction": return t("animReactionDouble");
    default: return card.triggerKind || card.stateKey || card.id;
  }
}

function getAnimOverrideSectionTitle(section) {
  if (!section || !section.id) return "";
  switch (section.id) {
    case "idle": return t("animOverridesSectionIdle");
    case "work": return t("animOverridesSectionWork");
    case "interrupts": return t("animOverridesSectionInterrupts");
    case "sleep": return t("animOverridesSectionSleep");
    case "mini": return t("animOverridesSectionMini");
    case "reactions": return t("animOverridesSectionReactions");
    default: return section.id;
  }
}

function getAnimOverrideSectionSubtitle(section) {
  if (!section) return "";
  if (section.id === "idle") {
    if (section.mode === "tracked") return t("animOverridesSectionIdleTracked");
    if (section.mode === "animated") return t("animOverridesSectionIdleAnimated");
    if (section.mode === "static") return t("animOverridesSectionIdleStatic");
  }
  if (section.id === "sleep") {
    if (section.mode === "full") return t("animOverridesSectionSleepFull");
    if (section.mode === "direct") return t("animOverridesSectionSleepDirect");
  }
  return "";
}

function buildAnimOverrideSection(section) {
  const wrapper = document.createElement("section");
  wrapper.className = "anim-override-section";

  const head = document.createElement("div");
  head.className = "anim-override-section-head";

  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = getAnimOverrideSectionTitle(section);
  head.appendChild(title);

  const subtitleText = getAnimOverrideSectionSubtitle(section);
  if (subtitleText) {
    const subtitle = document.createElement("div");
    subtitle.className = "anim-override-section-subtitle";
    subtitle.textContent = subtitleText;
    head.appendChild(subtitle);
  }
  wrapper.appendChild(head);

  const list = document.createElement("div");
  list.className = "anim-override-list";
  for (const card of (section.cards || [])) {
    list.appendChild(buildAnimOverrideRow(card));
  }
  wrapper.appendChild(list);
  return wrapper;
}

function buildAnimPreviewNode(fileUrl) {
  const frame = document.createElement("div");
  frame.className = "anim-override-preview-frame";
  if (fileUrl) {
    const img = document.createElement("img");
    img.src = fileUrl;
    img.alt = "";
    img.draggable = false;
    frame.appendChild(img);
  } else {
    const glyph = document.createElement("span");
    glyph.className = "theme-thumb-empty";
    glyph.textContent = t("themeThumbMissing");
    frame.appendChild(glyph);
  }
  return frame;
}

function renderAnimOverridesTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("animOverridesTitle");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("animOverridesSubtitle");
  parent.appendChild(subtitle);

  if (animationOverridesData === null) {
    const loading = document.createElement("div");
    loading.className = "placeholder-desc";
    parent.appendChild(loading);
    fetchAnimationOverridesData().then(() => {
      if (activeTab === "animOverrides") renderContent();
    });
    return;
  }

  const data = animationOverridesData;
  const themeMeta = document.createElement("div");
  themeMeta.className = "anim-override-meta";
  const themeLabel = document.createElement("div");
  themeLabel.className = "anim-override-meta-label";
  themeLabel.textContent = `${t("animOverridesCurrentTheme")}: ${(data.theme && data.theme.name) || "clawd"}`;
  themeMeta.appendChild(themeLabel);

  const themeBtn = document.createElement("button");
  themeBtn.type = "button";
  themeBtn.className = "soft-btn";
  themeBtn.textContent = t("animOverridesOpenThemeTab");
  themeBtn.addEventListener("click", () => {
    activeTab = "theme";
    renderSidebar();
    renderContent();
  });
  themeMeta.appendChild(themeBtn);

  const assetsBtn = document.createElement("button");
  assetsBtn.type = "button";
  assetsBtn.className = "soft-btn";
  assetsBtn.textContent = t("animOverridesOpenAssets");
  attachActivation(assetsBtn, () => window.settingsAPI.openThemeAssetsDir());
  themeMeta.appendChild(assetsBtn);

  const themeId = data.theme && data.theme.id;
  const resetAllBtn = document.createElement("button");
  resetAllBtn.type = "button";
  resetAllBtn.className = "soft-btn";
  resetAllBtn.textContent = t("animOverridesResetAll");
  resetAllBtn.disabled = !themeId || readThemeOverrideMap(themeId) === null;
  attachActivation(resetAllBtn, () =>
    window.settingsAPI.command("resetThemeOverrides", { themeId }).then((result) => {
      if (result && result.status === "ok" && !result.noop) {
        showToast(t("toastAnimMapResetOk"));
      }
      return result;
    })
  );
  themeMeta.appendChild(resetAllBtn);

  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.className = "soft-btn";
  exportBtn.textContent = t("animOverridesExport");
  attachActivation(exportBtn, () =>
    window.settingsAPI.exportAnimationOverrides().then((result) => {
      if (!result) return result;
      const lang = (snapshot && snapshot.lang) || "en";
      const dict = STRINGS[lang] || STRINGS.en;
      if (result.status === "ok") {
        showToast(dict.toastAnimOverridesExportOk(result.themeCount || 0, result.path || ""));
      } else if (result.status === "empty") {
        showToast(dict.toastAnimOverridesExportEmpty);
      } else if (result.status === "error") {
        showToast(dict.toastAnimOverridesExportFailed(result.message || ""), { error: true });
      }
      return result;
    })
  );
  themeMeta.appendChild(exportBtn);

  const importBtn = document.createElement("button");
  importBtn.type = "button";
  importBtn.className = "soft-btn";
  importBtn.textContent = t("animOverridesImport");
  attachActivation(importBtn, () =>
    window.settingsAPI.importAnimationOverrides().then((result) => {
      if (!result) return result;
      const lang = (snapshot && snapshot.lang) || "en";
      const dict = STRINGS[lang] || STRINGS.en;
      if (result.status === "ok") {
        showToast(dict.toastAnimOverridesImportOk(result.themeCount || 0));
      } else if (result.status === "error") {
        showToast(dict.toastAnimOverridesImportFailed(result.message || ""), { error: true });
      }
      return result;
    })
  );
  themeMeta.appendChild(importBtn);

  parent.appendChild(themeMeta);

  const sections = Array.isArray(data.sections) ? data.sections : [];
  for (const section of sections) {
    if (!section || !Array.isArray(section.cards) || !section.cards.length) continue;
    parent.appendChild(buildAnimOverrideSection(section));
  }
  renderAssetPickerModal();
}

function triggerPreviewOnce(card) {
  if (card.slotType === "reaction") {
    // Reactions live in the renderer's click-reaction layer, not the state
    // machine — preview through the reaction channel so we don't hijack
    // working/idle state for a non-logical visual.
    window.settingsAPI.previewReaction({
      file: card.currentFile,
      durationMs: getAnimationPreviewDuration(null, card),
    });
    return;
  }
  window.settingsAPI.previewAnimationOverride({
    stateKey: previewStateForCard(card),
    file: card.currentFile,
    durationMs: getAnimationPreviewDuration(null, card),
  });
}

function isCardOverridden(card) {
  const themeId = animationOverridesData && animationOverridesData.theme && animationOverridesData.theme.id;
  if (!themeId) return false;
  const map = readThemeOverrideMap(themeId);
  if (!map) return false;
  if (card.slotType === "tier") {
    const group = map.tiers && map.tiers[card.tierGroup];
    return !!(group && group[card.originalFile]);
  }
  if (card.slotType === "idleAnimation") {
    const group = map.idleAnimations;
    return !!(group && group[card.originalFile]);
  }
  const entry = map.states && map.states[card.stateKey];
  if (entry) return true;
  const autoReturn = map.timings && map.timings.autoReturn;
  return !!(autoReturn && Object.prototype.hasOwnProperty.call(autoReturn, card.stateKey));
}

function buildAnimOverrideRow(card) {
  const row = document.createElement("details");
  row.className = "anim-override-row";
  if (card.fallbackTargetState) row.classList.add("inherited");
  row.dataset.rowId = card.id;
  if (expandedOverrideRowIds.has(card.id)) row.open = true;
  row.addEventListener("toggle", () => {
    if (row.open) expandedOverrideRowIds.add(card.id);
    else expandedOverrideRowIds.delete(card.id);
  });

  row.appendChild(buildAnimOverrideSummary(card));
  row.appendChild(buildAnimOverrideDrawer(card));
  return row;
}

function buildAnimOverrideSummary(card) {
  const summary = document.createElement("summary");

  const chevron = document.createElement("span");
  chevron.className = "anim-override-chevron";
  chevron.textContent = "\u25B8"; // ▸
  chevron.setAttribute("aria-hidden", "true");
  summary.appendChild(chevron);

  const thumb = document.createElement("div");
  thumb.className = "anim-override-thumb";
  thumb.title = t("animOverridesPreview");
  if (card.currentFileUrl) {
    const img = document.createElement("img");
    img.src = card.currentFileUrl;
    img.alt = "";
    img.draggable = false;
    thumb.appendChild(img);
  }
  thumb.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    triggerPreviewOnce(card);
  });
  summary.appendChild(thumb);

  const text = document.createElement("div");
  text.className = "anim-override-summary-text";
  const trigger = document.createElement("div");
  trigger.className = "anim-override-trigger";
  trigger.textContent = getAnimOverrideTriggerLabel(card);
  text.appendChild(trigger);
  const file = document.createElement("div");
  file.className = "anim-override-file";
  file.textContent = card.currentFile;
  file.title = card.bindingLabel || "";
  text.appendChild(file);
  if (card.fallbackTargetState) {
    const chip = document.createElement("div");
    chip.className = "anim-override-fallback-chip";
    chip.title = getAnimFallbackHint(card);
    const arrow = document.createElement("span");
    arrow.className = "anim-override-fallback-chip-arrow";
    arrow.textContent = "\u21B7"; // ↷
    arrow.setAttribute("aria-hidden", "true");
    chip.appendChild(arrow);
    const target = document.createElement("span");
    target.textContent = card.fallbackTargetState;
    chip.appendChild(target);
    text.appendChild(chip);
  }
  summary.appendChild(text);

  const badges = document.createElement("div");
  badges.className = "anim-override-summary-badges";
  if (card.displayHintWarning) {
    const warn = document.createElement("span");
    warn.className = "anim-override-badge anim-override-badge-warn";
    warn.textContent = "\u26A0"; // ⚠
    warn.title = t("animOverridesDisplayHintWarning");
    badges.appendChild(warn);
  }
  if (isCardOverridden(card)) {
    const dotWrap = document.createElement("span");
    dotWrap.className = "anim-override-badge";
    dotWrap.title = t("animOverridesOverriddenTooltip");
    const dot = document.createElement("span");
    dot.className = "anim-override-badge-dot";
    dotWrap.appendChild(dot);
    badges.appendChild(dotWrap);
  }
  summary.appendChild(badges);

  const changeBtn = document.createElement("button");
  changeBtn.type = "button";
  changeBtn.className = "soft-btn accent anim-override-summary-change";
  changeBtn.textContent = card.fallbackTargetState ? t("animOverridesUseOwnFile") : t("animOverridesChangeFile");
  changeBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openAssetPicker(card);
  });
  summary.appendChild(changeBtn);

  return summary;
}

function buildAnimWideHitboxToggle(card) {
  const row = document.createElement("label");
  row.className = "anim-override-toggle-row";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = !!card.wideHitboxEnabled;
  const label = document.createElement("div");
  label.className = "anim-override-toggle-label";
  const title = document.createElement("div");
  title.className = "anim-override-toggle-title";
  title.textContent = t("animOverridesWideHitboxToggle");
  label.appendChild(title);
  const desc = document.createElement("div");
  desc.className = "anim-override-toggle-desc";
  desc.textContent = t("animOverridesWideHitboxDesc");
  label.appendChild(desc);
  if (card.wideHitboxOverridden) {
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "anim-override-reset-chip";
    badge.textContent = t("animOverridesWideHitboxResetToTheme");
    badge.addEventListener("click", (e) => {
      e.preventDefault();
      const themeId = animationOverridesData && animationOverridesData.theme && animationOverridesData.theme.id;
      if (!themeId || !card.currentFile) return;
      window.settingsAPI.command("setWideHitboxOverride", {
        themeId,
        file: card.currentFile,
        enabled: null,
      }).then((result) => {
        if (!result || result.status !== "ok" || result.noop) return;
        return fetchAnimationOverridesData().then(() => {
          if (activeTab === "animOverrides") renderContent();
        });
      });
    });
    label.appendChild(badge);
  }
  input.addEventListener("change", () => {
    const themeId = animationOverridesData && animationOverridesData.theme && animationOverridesData.theme.id;
    if (!themeId || !card.currentFile) return;
    window.settingsAPI.command("setWideHitboxOverride", {
      themeId,
      file: card.currentFile,
      enabled: input.checked,
    }).then((result) => {
      if (!result || result.status !== "ok" || result.noop) return;
      return fetchAnimationOverridesData().then(() => {
        if (activeTab === "animOverrides") renderContent();
      });
    });
  });
  row.appendChild(input);
  row.appendChild(label);
  return row;
}

function buildAnimOverrideDrawer(card) {
  const drawer = document.createElement("div");
  drawer.className = "anim-override-drawer";

  if (card.fallbackTargetState) {
    const hint = document.createElement("div");
    hint.className = "anim-override-binding";
    hint.textContent = getAnimFallbackHint(card);
    drawer.appendChild(hint);
  }

  if (card.displayHintWarning) {
    const warning = document.createElement("div");
    warning.className = "anim-override-warning";
    warning.textContent = t("animOverridesDisplayHintWarning");
    drawer.appendChild(warning);
  }

  if (card.aspectRatioWarning) {
    const warning = document.createElement("div");
    warning.className = "anim-override-warning";
    const diffPct = Math.round(card.aspectRatioWarning.diffRatio * 100);
    warning.textContent = t("animOverridesAspectWarning").replace("{pct}", String(diffPct));
    drawer.appendChild(warning);
  }

  const head = document.createElement("div");
  head.className = "anim-override-drawer-head";
  const bigPreview = document.createElement("div");
  bigPreview.className = "anim-override-drawer-preview";
  bigPreview.title = t("animOverridesPreview");
  if (card.currentFileUrl) {
    const img = document.createElement("img");
    img.src = card.currentFileUrl;
    img.alt = "";
    img.draggable = false;
    bigPreview.appendChild(img);
  }
  bigPreview.addEventListener("click", () => triggerPreviewOnce(card));
  head.appendChild(bigPreview);

  const info = document.createElement("div");
  info.className = "anim-override-drawer-info";
  const binding = document.createElement("div");
  binding.className = "anim-override-binding";
  binding.textContent = card.bindingLabel;
  info.appendChild(binding);
  info.appendChild(buildAnimTimingHint(
    t("animOverridesAssetCycle"),
    card.assetCycleMs,
    card.assetCycleStatus
  ));
  if ((card.supportsAutoReturn || card.supportsDuration) && card.assetCycleMs == null && card.suggestedDurationMs != null) {
    info.appendChild(buildAnimTimingHint(
      card.supportsDuration ? t("animOverridesDurationIdle") : t("animOverridesSuggestedTiming"),
      card.suggestedDurationMs,
      card.suggestedDurationStatus
    ));
  }
  if (!card.supportsAutoReturn && !card.supportsDuration) {
    const hint = document.createElement("div");
    hint.className = "anim-override-binding";
    hint.textContent = t("animOverridesContinuousHint");
    info.appendChild(hint);
  }
  head.appendChild(info);
  drawer.appendChild(head);

  const sliders = document.createElement("div");
  sliders.className = "anim-override-sliders";
  sliders.appendChild(buildAnimOverrideSliderRow({
    label: t("animOverridesFadeIn"),
    min: 0, max: 1000, step: 10,
    value: card.transition.in,
    onCommit: (v) => runAnimationOverrideCommand(card, {
      transition: { in: v, out: card.transition.out },
    }),
  }));
  sliders.appendChild(buildAnimOverrideSliderRow({
    label: t("animOverridesFadeOut"),
    min: 0, max: 1000, step: 10,
    value: card.transition.out,
    onCommit: (v) => runAnimationOverrideCommand(card, {
      transition: { in: card.transition.in, out: v },
    }),
  }));
  if (card.supportsAutoReturn) {
    const current = Number.isFinite(card.autoReturnMs) ? card.autoReturnMs : (card.suggestedDurationMs || 3000);
    sliders.appendChild(buildAnimOverrideSliderRow({
      label: t("animOverridesDuration"),
      min: 500, max: 10000, step: 100,
      value: current,
      numberMin: 500,
      numberMax: 60000,
      onCommit: (v) => {
        if (!Number.isFinite(v) || v < 500 || v > 60000) return;
        return runAnimationOverrideCommand(card, { autoReturnMs: v });
      },
    }));
  }
  if (card.supportsDuration) {
    const current = Number.isFinite(card.durationMs) ? card.durationMs : (card.suggestedDurationMs || 3000);
    sliders.appendChild(buildAnimOverrideSliderRow({
      label: t("animOverridesDurationIdle"),
      min: 500, max: 20000, step: 100,
      value: current,
      numberMin: 500,
      numberMax: 60000,
      onCommit: (v) => {
        if (!Number.isFinite(v) || v < 500 || v > 60000) return;
        return runAnimationOverrideCommand(card, { durationMs: v });
      },
    }));
  }
  drawer.appendChild(sliders);

  if (card.slotType !== "reaction") {
    drawer.appendChild(buildAnimWideHitboxToggle(card));
  }

  const footer = document.createElement("div");
  footer.className = "anim-override-drawer-footer";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "soft-btn";
  resetBtn.textContent = t("animOverridesReset");
  resetBtn.disabled = !isCardOverridden(card);
  attachActivation(resetBtn, () => {
    const patch = {
      file: null,
      transition: null,
      ...(card.supportsAutoReturn ? { autoReturnMs: null } : {}),
      ...(card.supportsDuration ? { durationMs: null } : {}),
    };
    return runAnimationOverrideCommand(card, patch);
  });
  footer.appendChild(resetBtn);
  drawer.appendChild(footer);

  return drawer;
}

function buildAnimOverrideSliderRow({ label, min, max, step, value, numberMin, numberMax, onCommit }) {
  const row = document.createElement("div");
  row.className = "anim-override-slider-row";

  const lbl = document.createElement("span");
  lbl.className = "anim-override-slider-label";
  lbl.textContent = label;
  row.appendChild(lbl);

  const range = document.createElement("input");
  range.type = "range";
  range.min = String(min);
  range.max = String(max);
  range.step = String(step);
  range.value = String(clampNumber(value, min, max));
  row.appendChild(range);

  const number = document.createElement("input");
  number.type = "number";
  number.min = String(Number.isFinite(numberMin) ? numberMin : min);
  number.max = String(Number.isFinite(numberMax) ? numberMax : max);
  number.step = String(step);
  number.value = String(value);
  row.appendChild(number);

  range.addEventListener("input", () => {
    number.value = range.value;
  });
  range.addEventListener("change", () => {
    const v = Number(range.value);
    if (Number.isFinite(v)) onCommit(v);
  });
  number.addEventListener("input", () => {
    const v = Number(number.value);
    if (Number.isFinite(v)) range.value = String(clampNumber(v, min, max));
  });
  const commitFromNumber = () => {
    const v = Number(number.value);
    if (Number.isFinite(v)) onCommit(v);
  };
  number.addEventListener("change", commitFromNumber);
  number.addEventListener("blur", commitFromNumber);

  return row;
}

function clampNumber(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return Math.min(Math.max(v, min), max);
}

function formatAnimTimingValue(ms, status) {
  if (status === "static") return "—";
  let text = Number.isFinite(ms) && ms > 0
    ? `${ms} ms`
    : t("animOverridesTimingUnavailable");
  if (status === "estimated") text += ` (${t("animOverridesTimingEstimated")})`;
  else if (status === "fallback") text += ` (${t("animOverridesTimingFallback")})`;
  return text;
}

function getAnimFallbackHint(card) {
  if (!card || !card.fallbackTargetState) return "";
  return t("animOverridesFallbackHint").replace("{state}", card.fallbackTargetState);
}

function buildAnimTimingHint(label, ms, status) {
  const line = document.createElement("div");
  line.className = "anim-override-binding";
  line.textContent = `${label}: ${formatAnimTimingValue(ms, status)}`;
  return line;
}

function getAnimationPreviewDuration(asset, card) {
  if (asset && Number.isFinite(asset.cycleMs) && asset.cycleMs > 0) return asset.cycleMs;
  if (card && Number.isFinite(card.previewDurationMs) && card.previewDurationMs > 0) return card.previewDurationMs;
  if (card && card.supportsAutoReturn && Number.isFinite(card.autoReturnMs) && card.autoReturnMs > 0) {
    return card.autoReturnMs;
  }
  return null;
}

function getSelectedAnimationAsset() {
  if (!assetPickerState || !animationOverridesData) return null;
  const assets = Array.isArray(animationOverridesData.assets) ? animationOverridesData.assets : [];
  return assets.find((asset) => asset.name === assetPickerState.selectedFile) || null;
}

function populateAssetPickerDetail(detail, selected) {
  detail.innerHTML = "";
  detail.appendChild(buildAnimPreviewNode(selected && selected.fileUrl));
  const selectedLabel = document.createElement("div");
  selectedLabel.className = "anim-override-file";
  selectedLabel.textContent = `${t("animOverridesModalSelected")}: ${selected ? selected.name : "-"}`;
  detail.appendChild(selectedLabel);
  detail.appendChild(buildAnimTimingHint(
    t("animOverridesAssetCycle"),
    selected && selected.cycleMs,
    selected && selected.cycleStatus
  ));
}

function syncAssetPickerSelectionUi() {
  const root = document.getElementById("modalRoot");
  if (!root || !assetPickerState) return;
  const selected = getSelectedAnimationAsset();
  for (const item of root.querySelectorAll(".asset-picker-item")) {
    item.classList.toggle("active", item.dataset.assetName === (selected && selected.name));
  }
  const detail = root.querySelector(".asset-picker-detail");
  if (detail) populateAssetPickerDetail(detail, selected);
  const previewBtn = root.querySelector(".asset-picker-preview-btn");
  if (previewBtn) previewBtn.disabled = !selected;
  const useBtn = root.querySelector(".asset-picker-use-btn");
  if (useBtn) useBtn.disabled = !selected;
}

function renderAssetPickerModal() {
  const root = document.getElementById("modalRoot");
  if (!root) return;
  captureAssetPickerScrollState();
  root.innerHTML = "";
  if (!assetPickerState || !animationOverridesData) return;
  const card = getAnimOverrideCardById(assetPickerState.cardId);
  if (!card) {
    closeAssetPicker();
    return;
  }
  normalizeAssetPickerSelection();
  const assets = Array.isArray(animationOverridesData.assets) ? animationOverridesData.assets : [];
  const selected = getSelectedAnimationAsset();

  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) closeAssetPicker();
  });

  const modal = document.createElement("div");
  modal.className = "asset-picker-modal";

  const title = document.createElement("h2");
  title.textContent = t("animOverridesModalTitle");
  modal.appendChild(title);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("animOverridesModalSubtitle");
  modal.appendChild(subtitle);

  const refreshRow = document.createElement("div");
  refreshRow.className = "asset-picker-toolbar";
  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "soft-btn";
  refreshBtn.textContent = t("animOverridesRefresh");
  attachActivation(refreshBtn, () => fetchAnimationOverridesData().then(() => {
    normalizeAssetPickerSelection();
    renderAssetPickerModal();
    return { status: "ok" };
  }));
  refreshRow.appendChild(refreshBtn);

  const openAssetsBtn = document.createElement("button");
  openAssetsBtn.type = "button";
  openAssetsBtn.className = "soft-btn";
  openAssetsBtn.textContent = t("animOverridesOpenAssets");
  attachActivation(openAssetsBtn, () => window.settingsAPI.openThemeAssetsDir());
  refreshRow.appendChild(openAssetsBtn);
  modal.appendChild(refreshRow);

  const body = document.createElement("div");
  body.className = "asset-picker-body";

  const list = document.createElement("div");
  list.className = "asset-picker-list";
  if (!assets.length) {
    const empty = document.createElement("div");
    empty.className = "placeholder-desc";
    empty.textContent = t("animOverridesModalEmpty");
    list.appendChild(empty);
  } else {
    for (const asset of assets) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "asset-picker-item" + (selected && selected.name === asset.name ? " active" : "");
      item.dataset.assetName = asset.name;
      item.textContent = asset.name;
      item.addEventListener("click", () => {
        assetPickerState.selectedFile = asset.name;
        syncAssetPickerSelectionUi();
      });
      list.appendChild(item);
    }
  }
  body.appendChild(list);
  restoreAssetPickerScrollState(list);

  const detail = document.createElement("div");
  detail.className = "asset-picker-detail";
  populateAssetPickerDetail(detail, selected);
  body.appendChild(detail);
  modal.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "asset-picker-footer";

  const previewBtn = document.createElement("button");
  previewBtn.type = "button";
  previewBtn.className = "soft-btn asset-picker-preview-btn";
  previewBtn.textContent = t("animOverridesPreview");
  previewBtn.disabled = !selected;
  attachActivation(previewBtn, () => {
    const currentSelected = getSelectedAnimationAsset();
    if (!currentSelected) return { status: "error", message: "no asset selected" };
    return window.settingsAPI.previewAnimationOverride({
      stateKey: previewStateForCard(card),
      file: currentSelected.name,
      durationMs: getAnimationPreviewDuration(currentSelected, card),
    });
  });
  footer.appendChild(previewBtn);

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "soft-btn";
  cancelBtn.textContent = t("animOverridesModalCancel");
  cancelBtn.addEventListener("click", () => closeAssetPicker());
  footer.appendChild(cancelBtn);

  const useBtn = document.createElement("button");
  useBtn.type = "button";
  useBtn.className = "soft-btn accent asset-picker-use-btn";
  useBtn.textContent = t("animOverridesModalUse");
  useBtn.disabled = !selected;
  attachActivation(useBtn, () => {
    const currentSelected = getSelectedAnimationAsset();
    if (!currentSelected) return { status: "error", message: "no asset selected" };
    return runAnimationOverrideCommand(card, { file: currentSelected.name }).then((result) => {
      if (result && result.status === "ok") {
        closeAssetPicker();
        // Skip preview on no-op: the user didn't actually change anything, so
        // forcing a fresh applyState() on a continuous state (working/thinking/
        // juggling) would leave the pet stuck on the preview frame for
        // WORKING_STALE_MS (5 min) when a live CC session keeps resolveDisplayState
        // pinned to "working". See docs/plans/plan-settings-panel-3b-swap.md Path A MVP
        // preview semantics.
        const changed = !result.noop;
        if (changed) {
          const previewPromise = card.slotType === "reaction"
            ? (window.settingsAPI && typeof window.settingsAPI.previewReaction === "function"
                ? window.settingsAPI.previewReaction({
                    file: currentSelected.name,
                    durationMs: getAnimationPreviewDuration(currentSelected, card),
                  })
                : null)
            : (window.settingsAPI && typeof window.settingsAPI.previewAnimationOverride === "function"
                ? window.settingsAPI.previewAnimationOverride({
                    stateKey: previewStateForCard(card),
                    file: currentSelected.name,
                    durationMs: getAnimationPreviewDuration(currentSelected, card),
                  })
                : null);
          if (previewPromise) {
            previewPromise.then((previewResult) => {
              if (!previewResult || previewResult.status === "ok") return;
              showToast(t("toastSaveFailed") + previewResult.message, { error: true });
            }).catch((err) => {
              showToast(t("toastSaveFailed") + (err && err.message), { error: true });
            });
          }
        }
      }
      return result;
    });
  });
  footer.appendChild(useBtn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  root.appendChild(overlay);
}

function renderAgentsTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("agentsTitle");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("agentsSubtitle");
  parent.appendChild(subtitle);

  if (!agentMetadata || agentMetadata.length === 0) {
    const empty = document.createElement("div");
    empty.className = "placeholder";
    empty.innerHTML = `<div class="placeholder-desc">${escapeHtml(t("agentsEmpty"))}</div>`;
    parent.appendChild(empty);
    return;
  }

  const rows = agentMetadata.flatMap((agent) => buildAgentRows(agent));
  parent.appendChild(buildSection("", rows));
}

function buildAgentRows(agent) {
  const rows = [
    buildAgentSwitchRow({
      agent,
      flag: "enabled",
      extraClass: null,
      buildText: (text) => {
        const label = document.createElement("span");
        label.className = "row-label";
        label.textContent = agent.name || agent.id;
        text.appendChild(label);
        const badges = document.createElement("span");
        badges.className = "row-desc agent-badges";
        const esKey = agent.eventSource === "log-poll" ? "eventSourceLogPoll"
          : agent.eventSource === "plugin-event" ? "eventSourcePlugin"
          : "eventSourceHook";
        const esBadge = document.createElement("span");
        esBadge.className = "agent-badge";
        esBadge.textContent = t(esKey);
        badges.appendChild(esBadge);
        if (agent.capabilities && agent.capabilities.permissionApproval) {
          const permBadge = document.createElement("span");
          permBadge.className = "agent-badge accent";
          permBadge.textContent = t("badgePermissionBubble");
          badges.appendChild(permBadge);
        }
        text.appendChild(badges);
      },
    }),
  ];
  const caps = agent.capabilities || {};
  if (caps.permissionApproval || caps.interactiveBubble) {
    rows.push(buildAgentSwitchRow({
      agent,
      flag: "permissionsEnabled",
      extraClass: "row-sub",
      buildText: (text) => {
        const label = document.createElement("span");
        label.className = "row-label";
        label.textContent = t("rowAgentPermissions");
        text.appendChild(label);
        const desc = document.createElement("span");
        desc.className = "row-desc";
        desc.textContent = t("rowAgentPermissionsDesc");
        text.appendChild(desc);
      },
    }));
  }
  return rows;
}

function buildAgentSwitchRow({ agent, flag, extraClass, buildText }) {
  const row = document.createElement("div");
  row.className = extraClass ? `row ${extraClass}` : "row";

  const text = document.createElement("div");
  text.className = "row-text";
  buildText(text);
  row.appendChild(text);

  const ctrl = document.createElement("div");
  ctrl.className = "row-control";
  const sw = document.createElement("div");
  sw.className = "switch";
  sw.setAttribute("role", "switch");
  sw.setAttribute("tabindex", "0");
  const stateId = agentSwitchStateId(agent.id, flag);
  const override = transientUiState.agentSwitches.get(stateId);
  const committedVisual = readAgentFlagValue(agent.id, flag);
  setSwitchVisual(sw, override ? override.visualOn : committedVisual, {
    pending: override ? override.pending : false,
  });
  mountedControls.agentSwitches.set(stateId, {
    element: sw,
    agentId: agent.id,
    flag,
  });
  attachAnimatedSwitch(sw, {
    getCommittedVisual: () => readAgentFlagValue(agent.id, flag),
    getTransientState: () => transientUiState.agentSwitches.get(stateId) || null,
    setTransientState: (value) => transientUiState.agentSwitches.set(stateId, value),
    clearTransientState: (seq) => {
      const current = transientUiState.agentSwitches.get(stateId);
      if (!current || (seq !== undefined && current.seq !== seq)) return;
      transientUiState.agentSwitches.delete(stateId);
    },
    invoke: () =>
    window.settingsAPI.command("setAgentFlag", {
      agentId: agent.id,
      flag,
      value: !readAgentFlagValue(agent.id, flag),
    }),
  });
  ctrl.appendChild(sw);
  row.appendChild(ctrl);
  return row;
}

function renderPlaceholder(parent) {
  const div = document.createElement("div");
  div.className = "placeholder";
  div.innerHTML =
    `<div class="placeholder-icon">\u{1F6E0}</div>` +
    `<div class="placeholder-title">${escapeHtml(t("placeholderTitle"))}</div>` +
    `<div class="placeholder-desc">${escapeHtml(t("placeholderDesc"))}</div>`;
  parent.appendChild(div);
}

function renderGeneralTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("settingsTitle");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("settingsSubtitle");
  parent.appendChild(subtitle);

  // Section: Appearance
  parent.appendChild(buildSection(t("sectionAppearance"), [
    buildLanguageRow(),
    buildSizeSliderRow(),
    buildSwitchRow({
      key: "soundMuted",
      labelKey: "rowSound",
      descKey: "rowSoundDesc",
      // soundMuted is inverse: ON-switch means sound enabled.
      invert: true,
    }),
    buildSwitchRow({
      key: "allowEdgePinning",
      labelKey: "rowAllowEdgePinning",
      descKey: "rowAllowEdgePinningDesc",
    }),
  ]));

  // Section: Startup
  const manageClaudeHooksEnabled = !!(snapshot && snapshot.manageClaudeHooksAutomatically);
  parent.appendChild(buildSection(t("sectionStartup"), [
    buildSwitchRow({
      key: "manageClaudeHooksAutomatically",
      labelKey: "rowManageClaudeHooks",
      descKey: "rowManageClaudeHooksDesc",
      descExtraKey: "rowManageClaudeHooksOffNote",
      onToggle: ({ nextRaw }) => confirmDisableClaudeHookManagement(nextRaw),
      actionButton: {
        labelKey: "actionDisconnectClaudeHooks",
        invoke: () => runDisconnectClaudeHooks(),
      },
    }),
    buildSwitchRow({
      key: "openAtLogin",
      labelKey: "rowOpenAtLogin",
      descKey: "rowOpenAtLoginDesc",
    }),
    buildSwitchRow({
      key: "autoStartWithClaude",
      labelKey: "rowStartWithClaude",
      descKey: "rowStartWithClaudeDesc",
      descExtraKey: manageClaudeHooksEnabled ? null : "rowStartWithClaudeDisabledDesc",
      disabled: !manageClaudeHooksEnabled,
    }),
  ]));

  // Section: Bubbles
  parent.appendChild(buildSection(t("sectionBubbles"), [
    buildSwitchRow({
      key: "bubbleFollowPet",
      labelKey: "rowBubbleFollow",
      descKey: "rowBubbleFollowDesc",
    }),
    buildSwitchRow({
      key: "hideBubbles",
      labelKey: "rowHideBubbles",
      descKey: "rowHideBubblesDesc",
    }),
    buildSwitchRow({
      key: "showSessionId",
      labelKey: "rowShowSessionId",
      descKey: "rowShowSessionIdDesc",
    }),
  ]));
}

function buildSection(title, rows) {
  const section = document.createElement("section");
  section.className = "section";
  if (title) {
    const heading = document.createElement("h2");
    heading.className = "section-title";
    heading.textContent = title;
    section.appendChild(heading);
  }
  const wrap = document.createElement("div");
  wrap.className = "section-rows";
  for (const row of rows) wrap.appendChild(row);
  section.appendChild(wrap);
  return section;
}

// Wire click + Space/Enter keydown on any element to an async invoker that
// returns a `Promise<{status, message?}>`. Shared by switches and cards.
function attachActivation(el, invoke) {
  const run = () => {
    if (el.classList.contains("pending")) return;
    el.classList.add("pending");
    Promise.resolve()
      .then(invoke)
      .then((result) => {
        el.classList.remove("pending");
        if (!result || result.status !== "ok") {
          const msg = (result && result.message) || "unknown error";
          showToast(t("toastSaveFailed") + msg, { error: true });
        }
      })
      .catch((err) => {
        el.classList.remove("pending");
        showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      });
  };
  el.addEventListener("click", run);
  el.addEventListener("keydown", (ev) => {
    if (ev.key === " " || ev.key === "Enter") {
      ev.preventDefault();
      run();
    }
  });
}

function buildSwitchRow({
  key,
  labelKey,
  descKey,
  invert = false,
  disabled = false,
  descExtraKey = null,
  onToggle = null,
  actionButton = null,
}) {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML =
    `<div class="row-text">` +
      `<span class="row-label"></span>` +
      `<span class="row-desc"></span>` +
    `</div>` +
    `<div class="row-control"><div class="switch" role="switch" tabindex="0"></div></div>`;
  row.querySelector(".row-label").textContent = t(labelKey);
  const text = row.querySelector(".row-text");
  row.querySelector(".row-desc").textContent = t(descKey);
  if (descExtraKey) {
    const extra = document.createElement("span");
    extra.className = "row-desc";
    extra.textContent = t(descExtraKey);
    text.appendChild(extra);
  }
  const sw = row.querySelector(".switch");
  const control = row.querySelector(".row-control");
  const override = transientUiState.generalSwitches.get(key);
  const visualOn = override ? override.visualOn : readGeneralSwitchVisual(key, invert);
  setSwitchVisual(sw, visualOn, { pending: override ? override.pending : false });
  mountedControls.generalSwitches.set(key, { element: sw, invert });
  if (actionButton) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "soft-btn accent";
    btn.textContent = t(actionButton.labelKey);
    control.insertBefore(btn, sw);
    attachActivation(btn, actionButton.invoke);
  }
  if (disabled) {
    sw.classList.add("disabled");
    sw.setAttribute("aria-disabled", "true");
    sw.tabIndex = -1;
    return row;
  }
  attachAnimatedSwitch(sw, {
    getCommittedVisual: () => readGeneralSwitchVisual(key, invert),
    getTransientState: () => transientUiState.generalSwitches.get(key) || null,
    setTransientState: (value) => transientUiState.generalSwitches.set(key, value),
    clearTransientState: (seq) => {
      const current = transientUiState.generalSwitches.get(key);
      if (!current || (seq !== undefined && current.seq !== seq)) return;
      transientUiState.generalSwitches.delete(key);
    },
    invoke: () => {
      const currentRaw = readGeneralSwitchRaw(key);
      const currentVisual = invert ? !currentRaw : currentRaw;
      const nextVisual = !currentVisual;
      const nextRaw = invert ? !nextVisual : nextVisual;
      if (typeof onToggle === "function") {
        return onToggle({ currentRaw, currentVisual, nextRaw });
      }
      return window.settingsAPI.update(key, nextRaw);
    },
  });
  return row;
}

function confirmDisableClaudeHookManagement(nextRaw) {
  if (nextRaw) return window.settingsAPI.update("manageClaudeHooksAutomatically", true);
  if (!window.settingsAPI || typeof window.settingsAPI.confirmDisableClaudeHooks !== "function") {
    return window.settingsAPI.update("manageClaudeHooksAutomatically", false);
  }
  return window.settingsAPI.confirmDisableClaudeHooks().then((result) => {
    if (!result || result.choice === "cancel") return { status: "ok", noop: true };
    if (result.choice === "disconnect") return window.settingsAPI.command("uninstallHooks");
    return window.settingsAPI.update("manageClaudeHooksAutomatically", false);
  });
}

function runDisconnectClaudeHooks() {
  if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
    return Promise.resolve({ status: "error", message: "settings API unavailable" });
  }
  if (typeof window.settingsAPI.confirmDisconnectClaudeHooks !== "function") {
    return window.settingsAPI.command("uninstallHooks");
  }
  return window.settingsAPI.confirmDisconnectClaudeHooks().then((result) => {
    if (!result || !result.confirmed) return { status: "ok", noop: true };
    return window.settingsAPI.command("uninstallHooks");
  });
}

function buildLanguageRow() {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML =
    `<div class="row-text">` +
      `<span class="row-label"></span>` +
      `<span class="row-desc"></span>` +
    `</div>` +
      `<div class="row-control">` +
        `<div class="segmented" role="tablist">` +
          `<button data-lang="en"></button>` +
          `<button data-lang="zh"></button>` +
          `<button data-lang="ko"></button>` +
        `</div>` +
      `</div>`;
  row.querySelector(".row-label").textContent = t("rowLanguage");
  row.querySelector(".row-desc").textContent = t("rowLanguageDesc");
  const buttons = row.querySelectorAll(".segmented button");
  buttons[0].textContent = t("langEnglish");
  buttons[1].textContent = t("langChinese");
  buttons[2].textContent = t("langKorean");
  const current = (snapshot && snapshot.lang) || "en";
  for (const btn of buttons) {
    if (btn.dataset.lang === current) btn.classList.add("active");
    btn.addEventListener("click", () => {
      const next = btn.dataset.lang;
      if (next === ((snapshot && snapshot.lang) || "en")) return;
      window.settingsAPI.update("lang", next).then((result) => {
        if (!result || result.status !== "ok") {
          const msg = (result && result.message) || "unknown error";
          showToast(t("toastSaveFailed") + msg, { error: true });
        }
      }).catch((err) => {
        showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      });
    });
  }
  return row;
}

function buildSizeSliderRow() {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML =
    `<div class="row-text">` +
      `<span class="row-label"></span>` +
      `<span class="row-desc"></span>` +
    `</div>` +
    `<div class="row-control size-control">` +
      `<div class="size-slider-wrap">` +
        `<div class="size-bubble"></div>` +
        `<input type="range" class="size-slider" min="${SIZE_UI_MIN}" max="${SIZE_UI_MAX}" step="1" />` +
      `</div>` +
      `<div class="size-ticks"></div>` +
    `</div>`;
  row.querySelector(".row-label").textContent = t("rowSize");
  row.querySelector(".row-desc").textContent = t("rowSizeDesc");

  const control = row.querySelector(".size-control");
  const slider = row.querySelector(".size-slider");
  const bubble = row.querySelector(".size-bubble");
  const ticksEl = row.querySelector(".size-ticks");

  function applyLocalValue(ui) {
    const pct = sizeUiToPct(ui);
    slider.value = String(ui);
    slider.style.setProperty("--size-fill", `${pct}%`);
    bubble.textContent = `${ui}%`;
    bubble.style.left = `${pct}%`;
  }

  function setDragging(nextDragging, pending = transientUiState.size.pending) {
    control.classList.toggle("dragging", !!nextDragging);
    control.classList.toggle("pending", !!pending);
  }

  const initial =
    transientUiState.size.draftUi === null ? readSizeUiFromSnapshot() : transientUiState.size.draftUi;
  applyLocalValue(initial);
  setDragging(transientUiState.size.dragging, transientUiState.size.pending);

  for (const v of SIZE_TICK_VALUES) {
    const mark = document.createElement("span");
    mark.className = "size-tick";
    mark.dataset.value = String(v);
    mark.style.left = `${sizeUiToPct(v)}%`;
    const dot = document.createElement("span");
    dot.className = "size-tick-dot";
    const label = document.createElement("span");
    label.className = "size-tick-label";
    label.textContent = String(v);
    mark.appendChild(dot);
    mark.appendChild(label);
    ticksEl.appendChild(mark);
  }

  const controller = createSizeSliderController({
    readSnapshotUi: readSizeUiFromSnapshot,
    settingsAPI: window.settingsAPI,
    onLocalValue: (ui) => {
      transientUiState.size.draftUi = ui;
      applyLocalValue(ui);
    },
    onDraggingChange: (dragging, pending) => {
      transientUiState.size.dragging = dragging;
      transientUiState.size.pending = pending;
      setDragging(dragging, pending);
    },
    onError: (message) => {
      transientUiState.size.draftUi = null;
      applyLocalValue(readSizeUiFromSnapshot());
      if (message) showToast(t("toastSaveFailed") + message, { error: true });
    },
  });

  mountedControls.size = {
    row,
    syncFromSnapshot: (options) => controller.syncFromSnapshot(options),
    dispose: () => controller.dispose(),
  };
  controller.syncFromSnapshot();

  slider.addEventListener("pointerdown", () => { void controller.pointerDown(); });
  slider.addEventListener("pointerup", () => { void controller.pointerUp(); });
  slider.addEventListener("pointercancel", () => { void controller.pointerCancel(); });
  slider.addEventListener("blur", () => { void controller.blur(); });
  slider.addEventListener("input", () => {
    void controller.input(Number(slider.value));
  });
  slider.addEventListener("change", () => {
    void controller.change(Number(slider.value));
  });

  return row;
}

function getShortcutActionLabel(actionId) {
  const meta = SHORTCUT_ACTIONS[actionId];
  return meta ? t(meta.labelKey) : actionId;
}

function getShortcutValue(actionId) {
  const shortcuts = snapshot && snapshot.shortcuts;
  if (!shortcuts || typeof shortcuts !== "object") return null;
  return shortcuts[actionId] ?? null;
}

function translateShortcutError(message) {
  if (!message) return "";
  const conflictMatch = /^conflict: already bound to (.+)$/.exec(message);
  if (conflictMatch) {
    return t("shortcutErrorConflict").replace("{other}", getShortcutActionLabel(conflictMatch[1]));
  }
  if (message === "reserved accelerator") return t("shortcutErrorReserved");
  if (message === "invalid accelerator format") return t("shortcutErrorInvalid");
  if (message === "must include modifier") return t("shortcutErrorNeedsModifier");
  if (message.includes("unregister of old accelerator failed")) return t("shortcutErrorSystemConflict");
  if (message.includes("system conflict")) return t("shortcutErrorSystemConflict");
  return message;
}

function finishShortcutRecording() {
  if (!shortcutRecordingActionId) return Promise.resolve();
  shortcutRecordingActionId = null;
  shortcutRecordingError = "";
  shortcutRecordingPartial = [];
  if (activeTab === "shortcuts") renderContent();
  if (!window.settingsAPI || typeof window.settingsAPI.exitShortcutRecording !== "function") {
    return Promise.resolve();
  }
  return window.settingsAPI.exitShortcutRecording().catch(() => {});
}

function cancelShortcutRecording() {
  return finishShortcutRecording();
}

function enterShortcutRecording(actionId) {
  if (!window.settingsAPI || typeof window.settingsAPI.enterShortcutRecording !== "function") {
    showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
    return;
  }
  shortcutRecordingError = "";
  shortcutRecordingPartial = [];
  window.settingsAPI.enterShortcutRecording(actionId).then((result) => {
    if (!result || result.status !== "ok") {
      showToast(t("toastSaveFailed") + ((result && result.message) || "unknown error"), { error: true });
      return;
    }
    shortcutRecordingActionId = actionId;
    shortcutRecordingError = "";
    shortcutRecordingPartial = [];
    if (activeTab === "shortcuts") renderContent();
  }).catch((err) => {
    showToast(t("toastSaveFailed") + (err && err.message), { error: true });
  });
}

function handleShortcutRecordKey(payload) {
  if (!shortcutRecordingActionId) return;
  const built = buildAcceleratorFromEvent(payload, { isMac: IS_MAC });
  if (!built) return;
  if (built.action === "pending") {
    // Update live preview of modifiers held down so the user can see
    // "Ctrl+Shift+…" build up before the final non-modifier key commits.
    const nextPartial = Array.isArray(built.modifiers) ? built.modifiers : [];
    const changed = nextPartial.length !== shortcutRecordingPartial.length
      || nextPartial.some((m, i) => m !== shortcutRecordingPartial[i]);
    if (changed) {
      shortcutRecordingPartial = nextPartial;
      if (activeTab === "shortcuts") renderContent();
    }
    return;
  }
  if (built.action === "cancel") {
    cancelShortcutRecording();
    return;
  }
  if (built.action === "reject") {
    shortcutRecordingError = translateShortcutError(built.reason);
    shortcutRecordingPartial = [];
    if (activeTab === "shortcuts") renderContent();
    return;
  }
  const targetActionId = shortcutRecordingActionId;
  const prevValue = getShortcutValue(targetActionId);
  window.settingsAPI.command("registerShortcut", {
    actionId: targetActionId,
    accelerator: built.accelerator,
  }).then((result) => {
    if (result && result.status === "ok") {
      finishShortcutRecording();
      // Only toast when the value actually changed — if the user re-entered
      // the same combo (noop), don't pretend something was saved.
      if (prevValue !== built.accelerator) {
        showToast(t("shortcutToastSaved"));
      }
      return;
    }
    shortcutRecordingError = translateShortcutError(result && result.message);
    if (activeTab === "shortcuts") renderContent();
  }).catch((err) => {
    shortcutRecordingError = (err && err.message) || "";
    if (activeTab === "shortcuts") renderContent();
  });
}

function runShortcutAction(action, payload) {
  if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
    showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
    return;
  }
  window.settingsAPI.command(action, payload).then((result) => {
    if (!result || result.status !== "ok") {
      const message = translateShortcutError(result && result.message)
        || (t("toastSaveFailed") + "unknown error");
      showToast(message, { error: true });
    }
  }).catch((err) => {
    showToast(t("toastSaveFailed") + (err && err.message), { error: true });
  });
}

function buildShortcutButton(label, onClick, { disabled = false, accent = false } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "soft-btn" + (accent ? " accent" : "");
  btn.textContent = label;
  if (disabled) {
    btn.disabled = true;
    return btn;
  }
  btn.addEventListener("click", onClick);
  return btn;
}

function buildShortcutRow(actionId) {
  const row = document.createElement("div");
  row.className = "row shortcut-row";
  row.dataset.shortcutActionId = actionId;

  const textWrap = document.createElement("div");
  textWrap.className = "row-text";
  const label = document.createElement("span");
  label.className = "row-label";
  label.textContent = getShortcutActionLabel(actionId);
  textWrap.appendChild(label);

  const status = document.createElement("span");
  status.className = "row-desc";
  const isRecording = shortcutRecordingActionId === actionId;
  const failure = shortcutFailures && shortcutFailures[actionId];
  if (isRecording) {
    // Only surface errors here — the value box below already shows the
    // recording hint / live partial preview, so duplicating it in the left
    // column just makes it wrap to 3 lines and looks bad.
    if (shortcutRecordingError) {
      status.classList.add("shortcut-status-recording");
      status.textContent = shortcutRecordingError;
    } else {
      status.textContent = "";
    }
  } else if (failure) {
    status.classList.add("shortcut-status-warning");
    status.textContent = t("shortcutErrorRegistrationFailed");
  } else {
    status.textContent = "";
  }
  textWrap.appendChild(status);
  row.appendChild(textWrap);

  const control = document.createElement("div");
  control.className = "row-control shortcut-row-control";
  const value = document.createElement("div");
  value.className = "shortcut-value";
  if (!getShortcutValue(actionId)) value.classList.add("unassigned");
  if (isRecording) value.classList.add("recording");
  if (isRecording) {
    // Show "Ctrl+Shift+…" live as the user holds modifiers, fall back to
    // the hint until any modifier is pressed.
    const partial = shortcutRecordingPartial.length > 0
      ? formatAcceleratorPartial(shortcutRecordingPartial, { isMac: IS_MAC })
      : "";
    value.textContent = partial || t("shortcutRecordingHint");
  } else {
    value.textContent = formatAcceleratorLabel(getShortcutValue(actionId), {
      isMac: IS_MAC,
      unassignedLabel: t("shortcutUnassigned"),
    });
  }
  control.appendChild(value);

  if (failure && !isRecording) {
    const warning = document.createElement("span");
    warning.className = "shortcut-warning";
    warning.textContent = "⚠";
    warning.title = t("shortcutErrorRegistrationFailed");
    control.appendChild(warning);
  }

  // While any row is recording, lock down every row's action buttons (the
  // recording row's too — otherwise the user can hit Clear/Reset mid-capture
  // and break the "keyboard or Esc only" contract). Reset All follows the
  // same rule below.
  const anyRecording = !!shortcutRecordingActionId;
  control.appendChild(buildShortcutButton(
    t("shortcutRecordButton"),
    () => enterShortcutRecording(actionId),
    { disabled: anyRecording }
  ));
  control.appendChild(buildShortcutButton(
    t("shortcutClearButton"),
    () => runShortcutAction("registerShortcut", { actionId, accelerator: null }),
    { disabled: anyRecording || getShortcutValue(actionId) === null }
  ));
  control.appendChild(buildShortcutButton(
    t("shortcutResetButton"),
    () => runShortcutAction("resetShortcut", { actionId }),
    { disabled: anyRecording }
  ));

  row.appendChild(control);
  return row;
}

function renderShortcutsTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("shortcutsTitle");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("shortcutsSubtitle");
  parent.appendChild(subtitle);

  const head = document.createElement("div");
  head.className = "shortcuts-head";
  head.appendChild(document.createElement("div"));
  head.appendChild(buildShortcutButton(
    t("shortcutResetAllButton"),
    () => runShortcutAction("resetAllShortcuts", null),
    { disabled: !!shortcutRecordingActionId, accent: true }
  ));
  parent.appendChild(head);

  const rows = SHORTCUT_ACTION_IDS.map((actionId) => buildShortcutRow(actionId));
  parent.appendChild(buildSection("", rows));
}

// ── About tab ──
//
// Hero: Clawd "Deal with it" intro → freeze at cool pose (4.4s), then breathing.
// Click counter on the crab (7 reveals the easter-egg toast).
// Info rows (version / repo / license / author), collapsible contributors grid, footer.
let aboutInfoCache = null;
let aboutClickCount = 0;
let aboutContributorsExpanded = false;

function fetchAboutInfo() {
  if (aboutInfoCache) return Promise.resolve(aboutInfoCache);
  if (!window.settingsAPI || typeof window.settingsAPI.getAboutInfo !== "function") {
    return Promise.resolve(null);
  }
  return window.settingsAPI.getAboutInfo().then((info) => {
    aboutInfoCache = info;
    return info;
  }).catch(() => null);
}

function openExternalSafe(url) {
  if (!url) return;
  if (!window.settingsAPI || typeof window.settingsAPI.openExternal !== "function") return;
  window.settingsAPI.openExternal(url).then((result) => {
    if (result && result.status === "error") {
      showToast(t("aboutOpenExternalFailed"), { error: true });
    }
  }).catch(() => {
    showToast(t("aboutOpenExternalFailed"), { error: true });
  });
}

function handleAboutCrabClick(crabWrap) {
  const slot = crabWrap.querySelector("#shake-slot");
  if (slot) {
    slot.classList.remove("shake");
    void slot.getBoundingClientRect();
    slot.classList.add("shake");
    const onEnd = () => {
      slot.classList.remove("shake");
      slot.removeEventListener("animationend", onEnd);
    };
    slot.addEventListener("animationend", onEnd);
  }
  aboutClickCount++;
  if (aboutClickCount >= 7) {
    aboutClickCount = 0;
    showToast(t("aboutEasterEggToast"), { ttl: 5000 });
  }
}

function buildAboutLinkRow(label, url, displayText) {
  const row = document.createElement("div");
  row.className = "about-info-row";
  const l = document.createElement("div");
  l.className = "about-info-label";
  l.textContent = label;
  const v = document.createElement("div");
  v.className = "about-info-value";
  const a = document.createElement("a");
  a.href = "#";
  a.textContent = displayText;
  a.addEventListener("click", (e) => {
    e.preventDefault();
    openExternalSafe(url);
  });
  v.appendChild(a);
  row.appendChild(l);
  row.appendChild(v);
  return row;
}

function renderAboutTab(parent) {
  // Hero: SVG + title + tagline
  const hero = document.createElement("div");
  hero.className = "about-hero";

  const crabWrap = document.createElement("div");
  crabWrap.className = "about-crab-wrap";
  crabWrap.title = "Clawd";

  const title = document.createElement("h2");
  title.className = "about-title";
  title.textContent = "Clawd on Desk";

  const tagline = document.createElement("p");
  tagline.className = "about-tagline";
  tagline.textContent = t("aboutTagline");

  hero.appendChild(crabWrap);
  hero.appendChild(title);
  hero.appendChild(tagline);
  parent.appendChild(hero);

  // Unified info section — version, repo, license, author, contributors
  // all share the same visual block (no extra section-gap between author
  // and contributors like an earlier draft that split them apart).
  const infoSection = document.createElement("section");
  infoSection.className = "section";
  parent.appendChild(infoSection);

  // Contributors header as an info-row (label + toggle button); list
  // appended right after, no visual gap before it.
  const contribRow = document.createElement("div");
  contribRow.className = "about-info-row";
  const contribLabel = document.createElement("div");
  contribLabel.className = "about-info-label";
  contribLabel.textContent = t("aboutContributorsLabel") + " (" + CONTRIBUTORS.length + ")";
  const toggleBtn = document.createElement("button");
  toggleBtn.className = "about-contributors-toggle";
  toggleBtn.textContent = aboutContributorsExpanded ? t("aboutContributorsHide") : t("aboutContributorsShowAll");
  contribRow.appendChild(contribLabel);
  contribRow.appendChild(toggleBtn);

  const contribList = document.createElement("div");
  contribList.className = "about-contributors-list" + (aboutContributorsExpanded ? "" : " collapsed");
  for (const name of CONTRIBUTORS) {
    const link = document.createElement("a");
    link.className = "about-contributor-link";
    link.textContent = "@" + name;
    link.href = "#";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      openExternalSafe("https://github.com/" + name);
    });
    contribList.appendChild(link);
  }

  toggleBtn.addEventListener("click", () => {
    aboutContributorsExpanded = !aboutContributorsExpanded;
    contribList.classList.toggle("collapsed", !aboutContributorsExpanded);
    toggleBtn.textContent = aboutContributorsExpanded
      ? t("aboutContributorsHide")
      : t("aboutContributorsShowAll");
  });

  // Footer
  const footer = document.createElement("div");
  footer.className = "about-footer";
  footer.textContent = t("aboutFooter");
  parent.appendChild(footer);

  // Async: populate hero SVG and info rows
  fetchAboutInfo().then((info) => {
    const safe = info || {};

    if (safe.heroSvgContent) {
      // Inline SVG so the renderer can reach #shake-slot for the click reaction.
      // CSP blocks <object>/<iframe> under default-src 'none'.
      crabWrap.innerHTML = safe.heroSvgContent;
    }
    crabWrap.addEventListener("click", () => handleAboutCrabClick(crabWrap));

    infoSection.innerHTML = "";

    // Version + Check for Updates
    const versionRow = document.createElement("div");
    versionRow.className = "about-info-row";
    const vl = document.createElement("div");
    vl.className = "about-info-label";
    vl.textContent = t("aboutVersionLabel");
    const vvWrap = document.createElement("div");
    vvWrap.style.display = "flex";
    vvWrap.style.alignItems = "center";
    vvWrap.style.gap = "10px";
    const vv = document.createElement("span");
    vv.className = "about-info-value";
    vv.textContent = "v" + (safe.version || "?");
    const updateBtn = document.createElement("button");
    updateBtn.className = "about-check-update-btn";
    updateBtn.textContent = t("aboutCheckForUpdates");
    updateBtn.addEventListener("click", () => {
      if (!window.settingsAPI || typeof window.settingsAPI.checkForUpdates !== "function") return;
      updateBtn.disabled = true;
      window.settingsAPI.checkForUpdates()
        .catch(() => {})
        .finally(() => { updateBtn.disabled = false; });
    });
    vvWrap.appendChild(vv);
    vvWrap.appendChild(updateBtn);
    versionRow.appendChild(vl);
    versionRow.appendChild(vvWrap);
    infoSection.appendChild(versionRow);

    // Repository
    if (safe.repoUrl) {
      infoSection.appendChild(buildAboutLinkRow(
        t("aboutRepositoryLabel"),
        safe.repoUrl,
        safe.repoUrl.replace(/^https?:\/\//, "")
      ));
    }

    // License + copyright
    if (safe.license) {
      const lRow = document.createElement("div");
      lRow.className = "about-info-row";
      const ll = document.createElement("div");
      ll.className = "about-info-label";
      ll.textContent = t("aboutLicenseLabel");
      const lv = document.createElement("div");
      lv.className = "about-info-value";
      lv.textContent = safe.license + (safe.copyright ? " \u00b7 " + safe.copyright : "");
      lRow.appendChild(ll);
      lRow.appendChild(lv);
      infoSection.appendChild(lRow);
    }

    // Author
    if (safe.authorName) {
      infoSection.appendChild(buildAboutLinkRow(
        t("aboutAuthorLabel"),
        safe.authorUrl,
        safe.authorName
      ));
    }

    // Contributors (header row + collapsible list) appended last so
    // `about-info-row:last-child { border-bottom: none }` hits the
    // contributor row cleanly. List is a sibling; its own visual padding
    // handles spacing when expanded.
    infoSection.appendChild(contribRow);
    infoSection.appendChild(contribList);
  });
}

// ── Boot ──
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

window.settingsAPI.onChanged((payload) => {
  if (payload && payload.snapshot) {
    snapshot = payload.snapshot;
  } else if (payload && payload.changes && snapshot) {
    snapshot = { ...snapshot, ...payload.changes };
  }
  // Guard against an early broadcast that lands before `getSnapshot()`
  // resolves — rendering with a null snapshot blanks the UI and the
  // initial render later would need to re-fetch static language state.
  if (!snapshot) return;
  const changes = payload && payload.changes;
  const needsAnimOverridesRefresh = !!(changes && (
    "theme" in changes || "themeVariant" in changes || "themeOverrides" in changes
  ));
  if (needsAnimOverridesRefresh) animationOverridesData = null;
  // Patch `active` in place when only `theme` changed — cheaper than
  // a full refetch. `themeOverrides` changes (e.g. removeTheme cleanup)
  // can alter the list shape, so those still refetch.
  if (changes && "themeOverrides" in changes) {
    // 只有 theme tab 关心 list（removeTheme cleanup 可能改 list 形态）。
    // animMap tab 的开关直接从 snapshot.themeOverrides 读，不用 refetch。
    if (activeTab === "theme") {
      fetchThemes().then(() => {
        renderSidebar();
        renderContent();
      });
      return;
    }
    if (activeTab === "animOverrides" || assetPickerState) {
      fetchAnimationOverridesData().then(() => {
        normalizeAssetPickerSelection();
        renderSidebar();
        renderContent();
        renderAssetPickerModal();
      });
      return;
    }
    renderSidebar();
    renderContent();
    return;
  }
  if (needsAnimOverridesRefresh && (activeTab === "animOverrides" || assetPickerState)) {
    fetchAnimationOverridesData().then(() => {
      normalizeAssetPickerSelection();
      renderSidebar();
      renderContent();
      renderAssetPickerModal();
    });
    return;
  }
  if (changes && "theme" in changes && themeList) {
    themeList = themeList.map((t) => ({ ...t, active: t.id === changes.theme }));
  }
  if (tryPatchActiveTabInPlace(changes)) {
    return;
  }
  renderSidebar();
  renderContent();
});

if (window.settingsAPI && typeof window.settingsAPI.getShortcutFailures === "function") {
  window.settingsAPI.getShortcutFailures().then((failures) => {
    shortcutFailures = failures || {};
    if (!shortcutFailureToastShown && Object.keys(shortcutFailures).length > 0) {
      shortcutFailureToastShown = true;
      showToast(t("shortcutErrorRegistrationFailed"), { error: true });
    }
    if (activeTab === "shortcuts") renderContent();
  }).catch((err) => {
    console.warn("settings: getShortcutFailures failed", err);
  });
}

if (window.settingsAPI && typeof window.settingsAPI.onShortcutFailuresChanged === "function") {
  window.settingsAPI.onShortcutFailuresChanged((failures) => {
    shortcutFailures = failures || {};
    if (!shortcutFailureToastShown && Object.keys(shortcutFailures).length > 0) {
      shortcutFailureToastShown = true;
      showToast(t("shortcutErrorRegistrationFailed"), { error: true });
    }
    if (activeTab === "shortcuts") renderContent();
  });
}

if (window.settingsAPI && typeof window.settingsAPI.onShortcutRecordKey === "function") {
  window.settingsAPI.onShortcutRecordKey((payload) => handleShortcutRecordKey(payload));
}

window.addEventListener("blur", () => {
  if (shortcutRecordingActionId) cancelShortcutRecording();
});

document.addEventListener("mousedown", (event) => {
  if (!shortcutRecordingActionId) return;
  const target = event.target;
  const row = target && typeof target.closest === "function"
    ? target.closest("[data-shortcut-action-id]")
    : null;
  if (row && row.dataset.shortcutActionId === shortcutRecordingActionId) return;
  cancelShortcutRecording();
});

window.settingsAPI.getSnapshot().then((snap) => {
  snapshot = snap || {};
  renderSidebar();
  renderContent();
});

// Fetch static agent metadata once at boot. It's a pure lookup from
// agents/registry.js — no runtime state — so there's no refresh loop.
if (typeof window.settingsAPI.listAgents === "function") {
  window.settingsAPI
    .listAgents()
    .then((list) => {
      agentMetadata = Array.isArray(list) ? list : [];
      if (activeTab === "agents") renderContent();
    })
    .catch((err) => {
      console.warn("settings: listAgents failed", err);
      agentMetadata = [];
    });
}
