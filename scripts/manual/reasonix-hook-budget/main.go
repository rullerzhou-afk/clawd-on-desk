// Manual validation of the real Reasonix consumer; not part of Clawd runtime.
// Copy it to cmd/clawd-consumer-check/main.go inside the pinned Reasonix source.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"reasonix/internal/ext/hook"
)

type output struct {
	Event       string  `json:"event"`
	Platform    string  `json:"platform"`
	GoVersion   string  `json:"goVersion"`
	Blocked     bool    `json:"blocked"`
	TimedOut    bool    `json:"timedOut"`
	ExitCode    int     `json:"exitCode"`
	SpawnCount  int     `json:"spawnCount"`
	TimeoutMs   int64   `json:"timeoutMs"`
	ElapsedMs   float64 `json:"elapsedMs"`
	Stdout      string  `json:"stdout"`
	Stderr      string  `json:"stderr"`
	SpawnError  string  `json:"spawnError"`
	Message     string  `json:"message"`
	NoticeCount int     `json:"noticeCount"`
}

func main() {
	home := flag.String("home", "", "existing isolated test home")
	event := flag.String("event", "", "UserPromptSubmit or PreToolUse")
	expect := flag.String("expect", "pass", "pass or block (block must be a timeout)")
	flag.Parse()
	if runtime.GOOS != "windows" {
		fatal("this validation command must run on Windows")
	}
	if *home == "" || !filepath.IsAbs(*home) {
		fatal("-home must be the absolute isolated test home")
	}
	if *event != string(hook.UserPromptSubmit) && *event != string(hook.PreToolUse) {
		fatal("-event must be UserPromptSubmit or PreToolUse")
	}
	if *expect != "pass" && *expect != "block" {
		fatal("-expect must be pass or block")
	}
	reasonixHome := filepath.Join(*home, "reasonix")
	// Require the exact isolated file before Load. HomeDir also disables the
	// legacy user-home fallback, and Scopes excludes all project/plugin hooks.
	settingsPath := filepath.Join(reasonixHome, "settings.json")
	if info, err := os.Stat(settingsPath); err != nil || !info.Mode().IsRegular() {
		fatal("isolated settings.json does not exist")
	}
	hooks := hook.Load(hook.LoadOptions{
		HomeDir: *home, ReasonixHomeDir: reasonixHome,
		Scopes: []hook.Scope{hook.ScopeGlobal},
	})
	matching := 0
	for _, h := range hooks {
		if h.Event != hook.Event(*event) {
			continue
		}
		matching++
		if h.Timeout != 0 || h.ExecutionMode != hook.ExecutionLegacy || h.Argv != nil || h.Async || h.PayloadFormat != "" {
			fatal("fixture must retain native settings execution and default timeout")
		}
	}
	if matching != 1 {
		fatal("fixture must load exactly one hook for the selected event")
	}
	result := output{Event: *event, Platform: runtime.GOOS, GoVersion: runtime.Version(), ExitCode: -1}
	// Observation only: this delegates every SpawnInput unchanged to the real
	// official DefaultSpawner, including timeout, cmd.exe quoting, env and stdin.
	spawner := func(ctx context.Context, in hook.SpawnInput) hook.SpawnResult {
		result.SpawnCount++
		result.TimeoutMs = in.Timeout.Milliseconds()
		r := hook.DefaultSpawner(ctx, in)
		result.ExitCode, result.TimedOut = r.ExitCode, r.TimedOut
		result.Stdout, result.Stderr = r.Stdout, r.Stderr
		if r.SpawnErr != nil {
			result.SpawnError = r.SpawnErr.Error()
		}
		return r
	}
	runner := hook.NewRunner(hooks, *home, spawner, func(hook.Notice) { result.NoticeCount++ })
	runner.SetSessionID("clawd-native-consumer-fixture")
	started := time.Now()
	if *event == string(hook.UserPromptSubmit) {
		result.Blocked, result.Message = runner.PromptSubmit(context.Background(), "synthetic hook validation only", 1)
	} else {
		// This fires the hook only. No Bash/tool implementation or model runs.
		result.Blocked, result.Message = runner.PreToolUse(context.Background(), "bash", json.RawMessage(`{"command":"synthetic fixture, never executed"}`))
	}
	result.ElapsedMs = float64(time.Since(started).Microseconds()) / 1000
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fatal(err.Error())
	}
	valid := result.SpawnCount == 1 && result.TimeoutMs == 5000 && result.SpawnError == ""
	if *expect == "pass" {
		valid = valid && !result.Blocked && !result.TimedOut && result.ExitCode == 0 && result.Stdout == "" && result.Stderr == "" && result.NoticeCount == 0
	} else {
		valid = valid && result.Blocked && result.TimedOut && result.NoticeCount == 1
	}
	if !valid {
		os.Exit(1)
	}
}

func fatal(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(2)
}
