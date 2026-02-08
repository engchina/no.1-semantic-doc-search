"""
サービスロジックパッケージ

このパッケージには、ビジネスロジックを実装するサービスクラスが含まれています。
各サービスは特定のドメインの処理を担当し、データアクセスとビジネスルールをカプセル化します。

主なサービス:
- oci_service.py: Oracle Cloud Infrastructureとの連携処理
- database_service.py: データベース接続と操作管理
- document_processor.py: 文書処理（非推奨）
- image_vectorizer.py: 画像のベクトル化処理
- ai_copilot.py: AIアシスタント機能
- parallel_processor.py: 並列処理管理
- adb_service.py: Autonomous Database管理
- connection_pool_manager.py: データベース接続プール管理
"""
