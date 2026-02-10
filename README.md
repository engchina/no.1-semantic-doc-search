# No.1 Semantic Document Search

## Deploy

- v1.12.1: 大阪リージョンのみをサポートしています。（デフォルト：大阪リージョン）

  Click [![Deploy to Oracle Cloud](https://oci-resourcemanager-plugin.plugins.oci.oraclecloud.com/latest/deploy-to-oracle-cloud.svg)](https://cloud.oracle.com/resourcemanager/stacks/create?region=ap-osaka-1&zipUrl=https://github.com/engchina/no.1-semantic-doc-search/releases/download/v1.12.1/v1.12.1.zip)

## ネットワーク設定

デプロイ後、以下のネットワーク設定を行ってください：

1. **Computeインスタンスのセキュリティリスト**: インバウンドルールでポート80（HTTP）を開放してください
2. **ADBがPrivate Endpointの場合**: ADBのセキュリティリストにComputeインスタンスのプライベートIPを追加し、ポート1522（Oracle Net）のアクセスを許可してください