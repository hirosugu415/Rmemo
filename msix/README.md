# Microsoft Store 版（MSIX）の作り方

Store 版は MSIX パッケージで提出する。署名は Store が提出時に行うので、
コード署名証明書は不要。GitHub の setup.exe 版とは次の点が違う。

| | setup.exe 版 | Store 版（MSIX） |
|---|---|---|
| アップデート | アプリ内（GitHub Releases） | Store が自動で行う（アプリ内の更新確認はオフ） |
| サインイン時の自動起動 | レジストリの Run キー | マニフェストの StartupTask |
| SmartScreen の警告 | 出る | 出ない |

自動起動は、アプリが実行時にパッケージ版かどうかを判定して切り替える
（`src-tauri/src/packaged.rs`）。

## 初回だけ: Partner Center で名前を予約する

1. <https://storedeveloper.microsoft.com/> から個人の開発者として登録する（無料、本人確認あり）。
2. Partner Center →「アプリとゲーム」→「新しい製品」→ **MSIX または PWA アプリ** を選び、名前 `Rmemo` を予約する。
3. その製品の「製品 ID」ページ（製品の管理 → 製品 ID）にある次の 3 つを控える。
   - パッケージ/ID/名前（例: `12345hirosugu415.Rmemo`）
   - パッケージ/ID/発行元（例: `CN=XXXXXXXX-XXXX-...`）
   - パッケージ/プロパティ/発行元の表示名
4. `msix/identity.example.json` を `msix/identity.json` にコピーして、上の 3 つを入れる。

## パッケージを作る

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-msix.ps1
```

`dist-msix/Rmemo_<version>.0_x64.msix` ができる。バージョンは
`src-tauri/tauri.conf.json` の値に `.0` を付けたもの。

### 提出前に手元で試す

Windows の設定 →「システム」→「開発者向け」で **開発者モード** をオンにして:

```powershell
Add-AppxPackage -Register dist-msix\stage\AppxManifest.xml
```

スタートメニューに Rmemo が出る。試し終わったら、スタートメニューから
アンインストールする。setup.exe 版を入れている場合は、ホットキーがぶつかるので先に終了しておく。

## 提出する

Partner Center の製品ページ →「申請の開始」で次を埋める。説明文などの貼り付け用の文章は
[STORE-LISTING.md](STORE-LISTING.md) にある。

- **パッケージ**: 作った `.msix` をアップロード
- **ストア登録情報**（日本語）: 説明文、スクリーンショット（1366×768 以上の PNG を 1 枚以上）、
  ストア用ロゴ
- **プライバシーポリシーの URL**: <https://hirosugu415.github.io/Rmemo/privacy.html>
- **Web サイト**: <https://hirosugu415.github.io/Rmemo/>
- **価格**: 無料
- **年齢区分**: アンケートに答える（暴力表現などは無し）
- **申請オプション**: `runFullTrust` の利用理由を聞かれたら「デスクトップアプリとして、
  グローバルホットキー・タスクトレイ常駐・ローカルのメモフォルダの読み書きに必要」と書く

審査は通常 1〜3 営業日。

## 新しいバージョンを出すとき

1. バージョンを上げて GitHub でリリースする（ルートの `.github/workflows/release.yml`）。
2. `scripts/build-msix.ps1` で MSIX を作り直し、Partner Center で新しい申請にアップロードする。
