# urilog（ウリログ）

ウリログ（恋人と共有するおでかけ候補）のアプリ本体です（データは入っていません。ログインした本人だけが自分のデータを読み書きできます）。ルールは firestore.rules。

もとは `apps` リポジトリの中の `futari` フォルダでしたが、2026-11-24 に独立したリポジトリに分けました。

- 機能ごとにファイルを分けている：core.js（共通の道具・状態）→ auth / main / memories / uri / uri-fun / couple / quiz / sheets → events.js（ボタン）→ boot.js（Firebaseにつないで起動）。見た目は app.css
- `shared/` … 共通の土台（ログイン・保存と同期）

## 公開

main に反映すると、GitHub Actions（`.github/workflows/pages.yml`）が GitHub Pages に公開します。公開の直前に `.github/scripts/stamp.py` が版の番号（日本時間の日時）を自動で付けます。
（リポジトリの Settings → Pages → Source は「GitHub Actions」にしておく）
