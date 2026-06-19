#!/usr/bin/env python3
"""ZoomPhoneライセンス割り当てユーザーをGoogle Sheetsに自動集計するスクリプト。

使い方:
  1. .env ファイルに認証情報を設定する（zoom_phone_sync.env.example を参照）
  2. python scripts/zoom_phone_sync.py
"""

import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

SPREADSHEET_ID = "1Q_l5s4ZAnjceMFORoRfGokBFnEiGLJSmY3ogZw1Iz94"
TARGET_SHEET = "ZoomPhone_自動集計"
HR_DB_SHEET = "人事データベース"
HR_DB_HEADER_ROW = "A5:BA2000"
CURRENT_MONTH = datetime.now().strftime("%Y/%m")


# ---------- Zoom API ----------

def zoom_get_token() -> str:
    account_id = os.environ["ZOOM_ACCOUNT_ID"]
    client_id = os.environ["ZOOM_CLIENT_ID"]
    client_secret = os.environ["ZOOM_CLIENT_SECRET"]

    params = urllib.parse.urlencode(
        {"grant_type": "account_credentials", "account_id": account_id}
    )
    creds = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    req = urllib.request.Request(
        f"https://zoom.us/oauth/token?{params}",
        method="POST",
        headers={"Authorization": f"Basic {creds}"},
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())["access_token"]


JAPAN_UNLIMITED_NAMES = {"jp unlimited calling plan", "japan unlimited", "日本無制限"}


def zoom_get_phone_users(token: str) -> list[dict]:
    users = []
    next_page_token = None

    while True:
        params = {"page_size": 100, "type": "assigned"}
        if next_page_token:
            params["next_page_token"] = next_page_token

        url = f"https://api.zoom.us/v2/phone/users?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})

        try:
            with urllib.request.urlopen(req) as resp:
                data = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"Zoom API エラー ({e.code}): {e.read().decode()}") from e

        users.extend(data.get("users", []))
        next_page_token = data.get("next_page_token")
        if not next_page_token:
            break

    # パッケージが「日本無制限」のユーザーのみに絞り込む
    filtered = [
        u for u in users
        if any(
            p.get("name", "").lower() in JAPAN_UNLIMITED_NAMES
            for p in u.get("calling_plans", [])
        )
    ]
    return filtered


# ---------- Google Sheets（gws CLI経由） ----------

def _gws(args: list[str], body: dict | None = None) -> dict:
    cmd = ["gws"] + args
    if body:
        cmd += ["--json", json.dumps(body, ensure_ascii=False)]

    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        raise RuntimeError(f"gws 失敗:\n{result.stderr.strip()}")

    stdout = result.stdout.strip()
    return json.loads(stdout) if stdout else {}


def _sheets_batchget(ranges: list[str]) -> dict:
    return _gws([
        "sheets", "spreadsheets", "values", "batchGet",
        "--params", json.dumps({"spreadsheetId": SPREADSHEET_ID, "ranges": ranges}),
    ])


def _sheets_values_update(data: list[dict]) -> None:
    _gws(
        [
            "sheets", "spreadsheets", "values", "batchUpdate",
            "--params", json.dumps({"spreadsheetId": SPREADSHEET_ID}),
        ],
        body={"valueInputOption": "RAW", "data": data},
    )


def _sheets_batch_update(requests_list: list[dict]) -> dict:
    return _gws(
        [
            "sheets", "spreadsheets", "batchUpdate",
            "--params", json.dumps({"spreadsheetId": SPREADSHEET_ID}),
        ],
        body={"requests": requests_list},
    )


def _get_sheet_titles() -> set[str]:
    result = _gws([
        "sheets", "spreadsheets", "get",
        "--params", json.dumps({
            "spreadsheetId": SPREADSHEET_ID,
            "fields": "sheets.properties",
        }),
    ])
    return {s["properties"]["title"] for s in result.get("sheets", [])}


# ---------- ロジック ----------

def ensure_target_sheet(titles: set[str]) -> None:
    if TARGET_SHEET not in titles:
        print(f"  「{TARGET_SHEET}」タブを新規作成します...")
        _sheets_batch_update([{"addSheet": {"properties": {"title": TARGET_SHEET}}}])


def load_hr_maps() -> tuple[dict[str, str], dict[str, str]]:
    """人事データベース → フォールバックでアルバイトDB から
    {メールアドレス: 部署} と {メールアドレス: 氏名} のマップを返す。"""

    # ── メインDB ──
    result = _sheets_batchget([f"{HR_DB_SHEET}!{HR_DB_HEADER_ROW}"])
    rows = result["valueRanges"][0].get("values", [])
    if not rows:
        return {}, {}

    header = rows[0]
    try:
        email_idx = header.index("メールアドレス")
        dept_idx  = header.index("部署")
        name_idx  = header.index("氏名")
    except ValueError as e:
        raise RuntimeError(f"人事データベースに列が見つかりません: {e}") from e

    dept_map: dict[str, str] = {}
    name_map: dict[str, str] = {}
    for row in rows[1:]:
        if len(row) > email_idx and row[email_idx].strip():
            email = row[email_idx].strip().lower()
            dept_map[email] = row[dept_idx].strip() if len(row) > dept_idx else ""
            name_map[email] = row[name_idx].strip() if len(row) > name_idx else ""

    # ── フォールバック: アルバイトDB（メインDBに未登録のメールを補完）──
    arubait_result = _sheets_batchget(["人事データベース_アルバイト!A3:U500"])
    arubait_rows = arubait_result["valueRanges"][0].get("values", [])
    if arubait_rows:
        ah = arubait_rows[0]  # ヘッダー行
        try:
            a_email_idx = ah.index("メールアドレス")  # T列
            a_dept_idx  = ah.index("部署")            # L列
            a_name_idx  = ah.index("氏名")             # B列
        except ValueError:
            a_email_idx = None

        if a_email_idx is not None:
            for row in arubait_rows[1:]:
                if len(row) > a_email_idx and row[a_email_idx].strip():
                    email = row[a_email_idx].strip().lower()
                    if email not in dept_map:  # メインDBで未登録のみ追加
                        dept_map[email] = row[a_dept_idx].strip() if len(row) > a_dept_idx else ""
                        name_map[email] = row[a_name_idx].strip() if len(row) > a_name_idx else ""

    return dept_map, name_map


def load_target_sheet() -> list[list[str]]:
    result = _sheets_batchget([f"{TARGET_SHEET}!A1:ZZ2000"])
    return result["valueRanges"][0].get("values", [])


def build_updated_rows(
    rows: list[list[str]],
    zoom_users: list[dict],
    hr_dept_map: dict[str, str],
    hr_name_map: dict[str, str],
) -> list[list[str]]:
    BASE_HEADERS = ["氏名", "部門", "メールアドレス"]

    if not rows:
        rows = [BASE_HEADERS + [CURRENT_MONTH]]

    header = list(rows[0])
    if CURRENT_MONTH not in header:
        header.append(CURRENT_MONTH)

    col_name  = header.index("氏名") if "氏名" in header else 0
    col_dept  = header.index("部門") if "部門" in header else 1
    col_email = header.index("メールアドレス") if "メールアドレス" in header else 2
    col_month = header.index(CURRENT_MONTH)

    # 既存メールアドレス → 行インデックス（1 以降）
    email_to_row: dict[str, int] = {}
    for i, row in enumerate(rows[1:], 1):
        if len(row) > col_email and row[col_email].strip():
            email_to_row[row[col_email].strip()] = i

    # 当月列をいったん全クリア（前回実行の残留を除去）
    for row in rows[1:]:
        if len(row) > col_month:
            row[col_month] = ""

    for user in zoom_users:
        zoom_name = user.get("name", "").strip()
        email     = user.get("email", "").strip()
        email_lc  = email.lower()
        dept      = hr_dept_map.get(email_lc, "")
        name      = hr_name_map.get(email_lc, "") or zoom_name  # HR DB優先、なければZoom名

        if email in email_to_row:
            row = rows[email_to_row[email]]
            # 列が足りなければ拡張
            while len(row) <= col_month:
                row.append("")
            row[col_month] = "○"
            # 氏名・部署を人事DBの最新値で更新
            if name and len(row) > col_name:
                row[col_name] = name
            if dept and len(row) > col_dept:
                row[col_dept] = dept
        else:
            new_row = [""] * (col_month + 1)
            new_row[col_name]  = name
            new_row[col_dept]  = dept
            new_row[col_email] = email
            new_row[col_month] = "○"
            rows.append(new_row)

    rows[0] = header
    return rows


# ---------- .env 読み込み ----------

def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip())


# ---------- エントリーポイント ----------

def main() -> None:
    load_dotenv(Path(__file__).parent / "zoom_phone_sync.env")

    print("=== ZoomPhone 利用実績 自動集計 ===")
    print(f"対象月: {CURRENT_MONTH}\n")

    # 1. Zoom 認証
    print("[1/4] Zoom API に認証中...")
    try:
        token = zoom_get_token()
    except KeyError as e:
        print(f"エラー: 環境変数 {e} が設定されていません。")
        print("zoom_phone_sync.env.example を参考に zoom_phone_sync.env を作成してください。")
        sys.exit(1)
    print("  認証成功")

    # 2. ZoomPhone ユーザー取得
    print("[2/4] ZoomPhone ユーザーを取得中（パッケージ: 日本無制限）...")
    zoom_users = zoom_get_phone_users(token)
    print(f"  → {len(zoom_users)} 名（日本無制限フィルタ後）")

    # 3. 人事 DB 読み込み
    print("[3/4] 人事データベースから氏名・部署情報を読み込み中...")
    hr_dept_map, hr_name_map = load_hr_maps()
    matched = sum(1 for u in zoom_users if u.get("email", "").strip().lower() in hr_dept_map)
    print(f"  → {len(hr_dept_map)} 名分の情報を読み込み（ZoomPhone ユーザーとのマッチ: {matched} 名）")

    if matched < len(zoom_users):
        unmatched = [
            f"{u['name']} ({u.get('email', '')})" for u in zoom_users
            if u.get("email", "").strip().lower() not in hr_dept_map
        ]
        print("  人事DB未マッチのユーザー（Zoom表示名をそのまま使用、部門列は空白）:")
        for u_name in unmatched:
            print(f"    - {u_name}")

    # 4. シート更新
    print("[4/4] スプレッドシートを更新中...")
    titles = _get_sheet_titles()
    ensure_target_sheet(titles)
    existing_rows = load_target_sheet()
    updated_rows = build_updated_rows(existing_rows, zoom_users, hr_dept_map, hr_name_map)

    # B列（部門）昇順でデータ行をソート（ヘッダー行は除く）
    header_row = updated_rows[:1]
    data_rows  = updated_rows[1:]
    col_dept   = header_row[0].index("部門") if "部門" in header_row[0] else 1
    data_rows.sort(key=lambda r: r[col_dept] if len(r) > col_dept else "")
    updated_rows = header_row + data_rows

    _sheets_values_update([{"range": f"{TARGET_SHEET}!A1", "values": updated_rows}])

    print()
    print(f"[完了]「{TARGET_SHEET}」タブを更新しました。")
    url = f"https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}"
    print(f"   {url}")


if __name__ == "__main__":
    main()
