# chromasound

MIDIの曲を、光と軌跡に変えて見せるWebアプリ。登録した曲（最大20曲）は Vercel Blob に保存され、管理用パスワード（環境変数 `ADMIN_PASSWORD`）で追加・名前変更・削除ができます。

https://www.somikubota.jp/chromasound/

- `index.html` … 画面と描画・再生
- `api/songs.js` … 曲の一覧・MIDIファイルの受け渡し（Vercel Blob）

Vercel のプロジェクト `chromasound` から公開しています。

## PCで使う
- スペースキーで再生・一時停止できる
