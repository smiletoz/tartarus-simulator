# 繁中版維護說明

這個 repo 是原作者 [blahdot3h/tartarus-simulator](https://github.com/blahdot3h/tartarus-simulator) 的繁體中文翻譯版。翻譯不是直接改在檔案上維護，而是存成「修補檔」：

- `patches/`：每個原始檔一份修補，格式是「原文 ==== 譯文」，詳見 `apply.js` 檔頭。
- `apply.js`：把修補套到原作者的檔案上，產生翻譯後的版本。
- `GLOSSARY.md`：中英用語對照表。
- `UPSTREAM.txt`：目前對應的原作者版本（commit）。

repo 根目錄的其他檔案都是 `apply.js` 自動產生的，**要改翻譯請改 `patches/`，不要直接改根目錄的檔案**，否則下次同步會被蓋掉。

## 自動化（Actions 分頁）

- **Sync upstream**：每天台灣時間 04:40 自動執行，也能手動執行。抓原作者最新版、套用翻譯、提交。原作者改過的句子如果對不上，那幾句會暫時顯示英文，執行摘要會列出是哪幾段（✗）。**不要按 GitHub 的「Sync fork」**，會造成衝突。
- **Build desktop app**：手動執行。打包 Windows 程式並發布到 Releases，版本號自動遞增；已安裝的程式會在 6 小時內自動更新。

## 修正對不上的翻譯

1. 看 Sync upstream 摘要裡 ✗ 的那幾行，知道是哪個檔案、哪一段。
2. 在 `patches/` 對應的修補檔裡，把該段的原文改成原作者的新原文，譯文跟著更新。
3. 本機檢查：下載原作者最新版到 `upstream` 資料夾後，執行 `node zh-TW/apply.js upstream --check`。
4. 提交後手動執行一次 Sync upstream。

## 改譯名

用編輯器在 `patches/` 整個資料夾搜尋取代（只改 `====` 和 `>>>>` 之間的譯文），同時更新 `GLOSSARY.md`，然後執行 Sync upstream。

## 刻意保留英文的地方

- 截圖辨識：比對英文遊戲客戶端畫面的文字。
- 遊戲紀錄檔（UE_game.log）的比對規則。
- 回報給原作者伺服器的診斷資料、Windows 程式的除錯紀錄。
- 作者資訊與連結。
