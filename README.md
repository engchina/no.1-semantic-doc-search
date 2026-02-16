# No.1 Semantic Document Search

## Deploy

- v1.12.1: 大阪リージョンのみをサポートしています。（デフォルト：大阪リージョン）

  Click [![Deploy to Oracle Cloud](https://oci-resourcemanager-plugin.plugins.oci.oraclecloud.com/latest/deploy-to-oracle-cloud.svg)](https://cloud.oracle.com/resourcemanager/stacks/create?region=ap-osaka-1&zipUrl=https://github.com/engchina/no.1-semantic-doc-search/releases/download/v1.12.1/v1.12.1.zip)

## ネットワーク設定

デプロイ後、以下のネットワーク設定を行ってください：

1. **Computeインスタンスのセキュリティリスト**: インバウンドルールでポート80（HTTP）を開放してください
2. **ADBがPrivate Endpointの場合**: ADBのセキュリティリストにComputeインスタンスのプライベートIPを追加し、ポート1522（Oracle Net）のアクセスを許可してください

## ライセンス

本プロジェクトは **MIT** で提供されています。  
詳細は `LICENSE.txt` を参照してください。

## 利用ライブラリのライセンス一覧（主要な直接依存）

以下は、ローカル依存定義（`frontend/package-lock.json` / `backend/uv.lock`）を基準にし、公式公開情報（PyPI / npm / 公式サイト）で再確認した結果です。

### Frontend

| ライブラリ | バージョン | ライセンス |
|---|---:|---|
| @fortawesome/fontawesome-free | 6.5.1 | CC-BY-4.0 AND OFL-1.1 AND MIT |
| autoprefixer | 10.4.23 | MIT |
| jsdom | 28.0.0 | MIT |
| marked | 17.0.1 | MIT |
| postcss | 8.5.6 | MIT |
| tailwindcss | 3.4.19 | MIT |
| vite | 5.4.21 | MIT |

### Backend

| ライブラリ | バージョン | ライセンス |
|---|---:|---|
| fastapi | 0.128.0 | MIT |
| uvicorn | 0.40.0 | BSD-3-Clause |
| numpy | 2.4.1 | BSD-3-Clause（配布物に追加ライセンス表記あり） |
| pandas | 2.3.3 | BSD-3-Clause |
| python-multipart | 0.0.21 | Apache-2.0 |
| python-dotenv | 1.2.1 | BSD-3-Clause |
| oci | 2.165.1 | UPL-1.0 OR Apache-2.0 |
| pydantic | 2.12.5 | MIT |
| pypdf2 | 3.0.1 | BSD License |
| python-pptx | 1.0.2 | MIT |
| python-docx | 1.2.0 | MIT |
| pillow | 12.1.0 | MIT-CMU |
| oci-openai | 1.0.0 | UPL-1.0 |
| oracledb | 3.4.1 | Apache-2.0 OR UPL-1.0 |
| pdf2image | 1.17.0 | MIT |
| markdown2 | 2.5.4 | MIT |
| fpdf2 | 2.8.5 | LGPL-3.0-only |

### 注意事項

- `fpdf2` は `LGPL-3.0-only` です。動的インポートで使用する場合、LGPLは伝播しません。再配布時は以下のライセンス文書を同梱してください：
  - GNU Lesser General Public License v3.0: <https://www.gnu.org/licenses/lgpl-3.0.txt>
  - fpdf2 作者: David Ansermino (@davidanson) - https://github.com/py-pdf/fpdf2
- `@fortawesome/fontawesome-free` は複合ライセンスです（単一MITではありません）。CC BY 4.0 に基づき、以下の帰属表示が必要です：
  ```
  Font Awesome Free by Fonticons, Inc. - https://fontawesome.com
  License - https://fontawesome.com/license/free (Icons: CC BY 4.0, Fonts: SIL OFL 1.1, Code: MIT License)
  ```
- `oci` と `oracledb` はデュアルライセンスです。
- `numpy` は配布物に追加ライセンス/例外表記が含まれるため、再配布時は NumPy 配布物の `LICENSES` も確認してください。

### 参考リンク（公式情報）

- Font Awesome Free License: <https://fontawesome.com/license/free>
- npm: `autoprefixer` <https://www.npmjs.com/package/autoprefixer>
- npm: `jsdom` <https://www.npmjs.com/package/jsdom>
- npm: `marked` <https://www.npmjs.com/package/marked>
- npm: `postcss` <https://www.npmjs.com/package/postcss>
- npm: `tailwindcss` <https://www.npmjs.com/package/tailwindcss>
- npm: `vite` <https://www.npmjs.com/package/vite>
- PyPI: `fastapi` <https://pypi.org/project/fastapi/0.128.0/>
- PyPI: `uvicorn` <https://pypi.org/project/uvicorn/0.40.0/>
- PyPI: `numpy` <https://pypi.org/project/numpy/2.4.1/>
- PyPI: `pandas` <https://pypi.org/project/pandas/2.3.3/>
- PyPI: `python-multipart` <https://pypi.org/project/python-multipart/0.0.21/>
- PyPI: `python-dotenv` <https://pypi.org/project/python-dotenv/1.2.1/>
- PyPI: `oci` <https://pypi.org/project/oci/2.165.1/>
- PyPI: `pydantic` <https://pypi.org/project/pydantic/2.12.5/>
- PyPI: `PyPDF2` <https://pypi.org/project/PyPDF2/3.0.1/>
- PyPI: `python-pptx` <https://pypi.org/project/python-pptx/1.0.2/>
- PyPI: `python-docx` <https://pypi.org/project/python-docx/1.2.0/>
- PyPI: `Pillow` <https://pypi.org/project/pillow/12.1.0/>
- PyPI: `oci-openai` <https://pypi.org/project/oci-openai/1.0.0/>
- PyPI: `oracledb` <https://pypi.org/project/oracledb/3.4.1/>
- PyPI: `pdf2image` <https://pypi.org/project/pdf2image/1.17.0/>
- PyPI: `markdown2` <https://pypi.org/project/markdown2/2.5.4/>
- PyPI: `fpdf2` <https://pypi.org/project/fpdf2/2.8.5/>
