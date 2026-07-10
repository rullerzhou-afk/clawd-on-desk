#!/usr/bin/env python3
"""
4タブ（ZoomPhone_自動集計/Figma/TimesCar/Claude）に管掌列を追加し、
人事DBから値を同期して管掌昇順でソートする。

管掌列は部門列の左に挿入（既存の場合は値を更新）。

使い方:
  python scripts/sync_kancho.py
"""

import json
import subprocess

SPREADSHEET_ID = "1Q_l5s4ZAnjceMFORoRfGokBFnEiGLJSmY3ogZw1Iz94"
TARGET_TABS = ["ZoomPhone", "Figma", "TimesCar", "Claude"]
HR_DB_SHEET = "人事データベース"
HR_DB_RANGE = "A5:BA2000"


def _gws(args: list[str], body: dict | None = None) -> dict:
    cmd = ["gws"] + args
    if body:
        cmd += ["--json", json.dumps(body, ensure_ascii=False)]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        raise RuntimeError(f"gws 失敗:\n{result.stderr.strip()}")
    stdout = result.stdout.strip()
    return json.loads(stdout) if stdout else {}


def get_sheet_id(tab_name: str) -> int:
    result = _gws(["sheets", "spreadsheets", "get",
                   "--params", json.dumps({"spreadsheetId": SPREADSHEET_ID})])
    for sheet in result.get("sheets", []):
        if sheet["properties"]["title"] == tab_name:
            return sheet["properties"]["sheetId"]
    raise ValueError(f"シート「{tab_name}」が見つかりません")


def load_kancho_map() -> dict[str, str]:
    """人事DB + アルバイトDB から {email.lower(): 管掌} を返す。"""
    result = _gws([
        "sheets", "spreadsheets", "values", "batchGet",
        "--params", json.dumps({
            "spreadsheetId": SPREADSHEET_ID,
            "ranges": [f"{HR_DB_SHEET}!{HR_DB_RANGE}"],
        }),
    ])
    rows = result["valueRanges"][0].get("values", [])
    if not rows:
        return {}

    header = rows[0]
    try:
        email_idx  = header.index("メールアドレス")
        kancho_idx = header.index("管掌")
    except ValueError as e:
        raise RuntimeError(f"人事DBに列が見つかりません: {e}") from e

    kancho_map: dict[str, str] = {}
    for row in rows[1:]:
        if len(row) > email_idx and row[email_idx].strip():
            email = row[email_idx].strip().lower()
            kancho_map[email] = row[kancho_idx].strip() if len(row) > kancho_idx else ""

    # フォールバック: アルバイトDB（メインDBに未登録のメールを補完）
    arubait = _gws([
        "sheets", "spreadsheets", "values", "batchGet",
        "--params", json.dumps({
            "spreadsheetId": SPREADSHEET_ID,
            "ranges": ["人事データベース_アルバイト!A3:U500"],
        }),
    ])
    arubait_rows = arubait["valueRanges"][0].get("values", [])
    if arubait_rows:
        ah = arubait_rows[0]
        try:
            a_email_idx  = ah.index("メールアドレス")
            a_kancho_idx = ah.index("管掌")
        except ValueError:
            a_email_idx = None

        if a_email_idx is not None:
            for row in arubait_rows[1:]:
                if len(row) > a_email_idx and row[a_email_idx].strip():
                    email = row[a_email_idx].strip().lower()
                    if email not in kancho_map:
                        kancho_map[email] = row[a_kancho_idx].strip() if len(row) > a_kancho_idx else ""

    return kancho_map


def process_tab(tab_name: str, kancho_map: dict[str, str]) -> None:
    print(f"\n  [{tab_name}]")

    result = _gws([
        "sheets", "spreadsheets", "values", "batchGet",
        "--params", json.dumps({
            "spreadsheetId": SPREADSHEET_ID,
            "ranges": [f"'{tab_name}'!A1:AZ2000"],
        }),
    ])
    rows = result["valueRanges"][0].get("values", [])

    if not rows:
        print("    データなし、スキップ")
        return

    header = list(rows[0])

    if "部門" not in header:
        print("    「部門」列なし、スキップ")
        return
    if "メールアドレス" not in header:
        print("    「メールアドレス」列なし、スキップ")
        return

    col_dept  = header.index("部門")
    col_email = header.index("メールアドレス")

    if "管掌" not in header:
        # 部門の左に管掌列を挿入。既存の書式・条件付き書式も列とともに
        # シフトさせるため、値だけでなく実際の列挿入（insertDimension）を行う。
        sheet_id = get_sheet_id(tab_name)
        _gws(
            ["sheets", "spreadsheets", "batchUpdate",
             "--params", json.dumps({"spreadsheetId": SPREADSHEET_ID})],
            body={"requests": [{
                "insertDimension": {
                    "range": {"sheetId": sheet_id, "dimension": "COLUMNS",
                              "startIndex": col_dept, "endIndex": col_dept + 1},
                    "inheritFromBefore": False,
                }
            }]},
        )
        for row in rows:
            while len(row) < col_dept:
                row.append("")
            row.insert(col_dept, "")
        rows[0][col_dept] = "管掌"
        col_kancho = col_dept
        col_dept  += 1
        if col_email >= col_kancho:
            col_email += 1
        print(f"    「管掌」列を {col_kancho + 1} 列目に追加（列挿入）")
    else:
        col_kancho = header.index("管掌")
        print(f"    「管掌」列は既存（{col_kancho + 1} 列目）、値を更新")

    # 管掌値を埋める
    filled = 0
    for row in rows[1:]:
        while len(row) <= max(col_kancho, col_email):
            row.append("")
        email  = row[col_email].strip().lower() if col_email < len(row) else ""
        kancho = kancho_map.get(email, "")
        row[col_kancho] = kancho
        if kancho:
            filled += 1
    print(f"    管掌値設定: {filled} 行")

    # 管掌昇順ソート（ヘッダー行を除く）
    header_row = rows[:1]
    data_rows  = rows[1:]
    data_rows.sort(key=lambda r: r[col_kancho] if col_kancho < len(r) else "")
    rows = header_row + data_rows

    # 書き戻し
    _gws(
        [
            "sheets", "spreadsheets", "values", "batchUpdate",
            "--params", json.dumps({"spreadsheetId": SPREADSHEET_ID}),
        ],
        body={"valueInputOption": "RAW", "data": [{"range": f"{tab_name}!A1", "values": rows}]},
    )
    print("    書き込み完了")


def main() -> None:
    print("=== 管掌列追加・同期 ===")

    print("\n[1/2] 人事DBから管掌情報を読み込み中...")
    kancho_map = load_kancho_map()
    print(f"  → {len(kancho_map)} 名分")

    print("\n[2/2] 各タブを処理中...")
    for tab in TARGET_TABS:
        process_tab(tab, kancho_map)

    print(f"\n完了: https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}")


if __name__ == "__main__":
    main()
