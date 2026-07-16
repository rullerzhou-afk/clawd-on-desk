#!/usr/bin/env python3
"""
【スタメン】予実_ver1 タブの売上高6項目（TUNAG_MRR/TUNAG_初期費用/TUNAG_その他/
Watchy_MRR/Watchy_初期費用/Watchy_ツール外売上）について、当月・翌月の進行中の値
（実績が確定していない月は「見込」列）を読み取り、前回実行時との差分を
「売上高_週次差分履歴」タブに追記する。

実行タイミング: 毎週木曜12:00（スケジューラから起動）。

注意: このスクリプトは金額を標準出力に一切出さない。実行結果は件数・成否のみ表示する。

使い方:
  python scripts/revenue_weekly_diff.py
"""

import json
import subprocess
from datetime import datetime

SPREADSHEET_ID = "1nS2dcJugzaqqVhrSG9sA34nGq6bMBzFZBJTuA0HIN2k"
SOURCE_TAB = "【スタメン】予実_ver1"
HISTORY_TAB = "売上高_週次差分履歴"
ITEMS = [
    "TUNAG_MRR",
    "TUNAG_初期費用",
    "TUNAG_その他",
    "Watchy_MRR",
    "Watchy_初期費用",
    "Watchy_ツール外売上",
]
HISTORY_HEADER = ["記録日時", "対象月区分", "対象月", "項目", "今回値", "前回値", "差分", "差分率(%)"]


def _gws(args: list[str], body: dict | None = None) -> dict:
    cmd = ["gws"] + args
    if body:
        cmd += ["--json", json.dumps(body, ensure_ascii=False)]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        raise RuntimeError(f"gws 失敗:\n{result.stderr.strip()}")
    stdout = result.stdout.strip()
    return json.loads(stdout) if stdout else {}


def col_to_a1(idx: int) -> str:
    """0-indexed column number -> A1 column letters."""
    letters = ""
    idx += 1
    while idx > 0:
        idx, rem = divmod(idx - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def get_sheet_meta() -> list[dict]:
    result = _gws(["sheets", "spreadsheets", "get",
                   "--params", json.dumps({"spreadsheetId": SPREADSHEET_ID, "fields": "sheets.properties"})])
    return result.get("sheets", [])


def ensure_history_tab() -> None:
    sheets = get_sheet_meta()
    if any(s["properties"]["title"] == HISTORY_TAB for s in sheets):
        return
    _gws(
        ["sheets", "spreadsheets", "batchUpdate",
         "--params", json.dumps({"spreadsheetId": SPREADSHEET_ID})],
        body={"requests": [{"addSheet": {"properties": {"title": HISTORY_TAB}}}]},
    )
    _gws(
        ["sheets", "spreadsheets", "values", "update",
         "--params", json.dumps({
             "spreadsheetId": SPREADSHEET_ID,
             "range": f"'{HISTORY_TAB}'!A1",
             "valueInputOption": "RAW",
         })],
        body={"values": [HISTORY_HEADER]},
    )
    print(f"  history tab created: {HISTORY_TAB}")


def find_month_value_column(header_row2: list[str], header_row3: list[str], month_label: str) -> int:
    """month_label like '7月'. Returns 0-indexed column of the value cell
    (2nd column of the [予算_ver1, 実績/見込, 差] block matching that month)."""
    n = len(header_row2)
    for idx in range(n):
        if header_row2[idx] == month_label and (idx == 0 or header_row2[idx - 1] != month_label):
            value_idx = idx + 1
            label = header_row3[value_idx] if value_idx < len(header_row3) else ""
            if label not in ("実績", "見込"):
                raise RuntimeError(f"'{month_label}' ブロックの値列ラベルが想定外: '{label}'")
            return value_idx
    raise RuntimeError(f"'{month_label}' の列ブロックが見つかりません")


def find_item_rows(item_names: list[str]) -> dict[str, int]:
    """Returns {item_name: 1-indexed sheet row}."""
    result = _gws([
        "sheets", "spreadsheets", "values", "get",
        "--params", json.dumps({"spreadsheetId": SPREADSHEET_ID, "range": f"'{SOURCE_TAB}'!A1:C200"}),
    ])
    rows = result.get("values", [])
    rows_by_name: dict[str, int] = {}
    for i, row in enumerate(rows):
        for cell in row:
            cell = cell.strip() if isinstance(cell, str) else ""
            if cell in item_names and cell not in rows_by_name:
                rows_by_name[cell] = i + 1
    missing = [name for name in item_names if name not in rows_by_name]
    if missing:
        raise RuntimeError(f"項目が見つかりません: {missing}")
    return rows_by_name


def month_label(n: int) -> str:
    return f"{n}月"


def calendar_label(year: int, month: int) -> str:
    return f"{year}年{month}月"


def next_month(year: int, month: int) -> tuple[int, int]:
    if month == 12:
        return year + 1, 1
    return year, month + 1


def load_history_rows() -> list[list[str]]:
    result = _gws([
        "sheets", "spreadsheets", "values", "get",
        "--params", json.dumps({"spreadsheetId": SPREADSHEET_ID, "range": f"'{HISTORY_TAB}'!A2:H100000"}),
    ])
    return result.get("values", [])


def latest_prev_value(history_rows: list[list[str]], target_month: str, item: str) -> float | None:
    for row in reversed(history_rows):
        if len(row) >= 5 and row[2] == target_month and row[3] == item:
            try:
                return float(str(row[4]).replace(",", ""))
            except ValueError:
                return None
    return None


def main() -> None:
    now = datetime.now()
    today_year, today_month = now.year, now.month
    targets = [("当月", today_year, today_month)]
    ny, nm = next_month(today_year, today_month)
    if today_month == 12:
        print("  当月が12月のため、翌月（翌FY）はこのタブの対象外としてスキップします。")
    else:
        targets.append(("翌月", ny, nm))

    print("=== 売上高 週次差分 集計 ===")
    print(f"実行時刻: {now.strftime('%Y-%m-%d %H:%M')}")

    ensure_history_tab()

    item_rows = find_item_rows(ITEMS)

    header = _gws([
        "sheets", "spreadsheets", "values", "batchGet",
        "--params", json.dumps({
            "spreadsheetId": SPREADSHEET_ID,
            "ranges": [f"'{SOURCE_TAB}'!A2:CZ3"],
        }),
    ])
    value_ranges = header["valueRanges"][0].get("values", [])
    header_row2 = value_ranges[0] if len(value_ranges) > 0 else []
    header_row3 = value_ranges[1] if len(value_ranges) > 1 else []

    history_rows = load_history_rows()

    ranges = []
    cell_keys = []
    for kubun, y, m in targets:
        try:
            col_idx = find_month_value_column(header_row2, header_row3, month_label(m))
        except RuntimeError as e:
            print(f"  スキップ ({kubun} {y}年{m}月): {e}")
            continue
        col_letter = col_to_a1(col_idx)
        for item in ITEMS:
            row_num = item_rows[item]
            ranges.append(f"'{SOURCE_TAB}'!{col_letter}{row_num}")
            cell_keys.append((kubun, calendar_label(y, m), item))

    if not ranges:
        print("対象列が見つからず、処理を中止しました。")
        return

    fetched = _gws([
        "sheets", "spreadsheets", "values", "batchGet",
        "--params", json.dumps({"spreadsheetId": SPREADSHEET_ID, "ranges": ranges}),
    ])

    new_rows = []
    ts = now.strftime("%Y-%m-%d %H:%M")
    for (kubun, cal_month, item), vr in zip(cell_keys, fetched.get("valueRanges", [])):
        vals = vr.get("values", [])
        raw = vals[0][0] if vals and vals[0] else ""
        try:
            current = float(str(raw).replace(",", "").replace("¥", ""))
        except ValueError:
            current = None

        prev = latest_prev_value(history_rows, cal_month, item)

        diff = current - prev if (current is not None and prev is not None) else ""
        diff_pct = (diff / prev * 100) if (isinstance(diff, float) and prev not in (None, 0)) else ""

        new_rows.append([
            ts, kubun, cal_month, item,
            current if current is not None else "",
            prev if prev is not None else "",
            diff,
            round(diff_pct, 2) if isinstance(diff_pct, float) else "",
        ])

    _gws(
        ["sheets", "spreadsheets", "values", "append",
         "--params", json.dumps({
             "spreadsheetId": SPREADSHEET_ID,
             "range": f"'{HISTORY_TAB}'!A1",
             "valueInputOption": "RAW",
             "insertDataOption": "INSERT_ROWS",
         })],
        body={"values": new_rows},
    )
    print(f"追記件数: {len(new_rows)} 行（金額は本ログには表示していません）")
    print(f"完了: https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}")


if __name__ == "__main__":
    main()
