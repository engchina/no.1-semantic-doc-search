# Object Storageバケットの作成
resource "oci_objectstorage_bucket" "document_storage_bucket" {
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.tenant_namespace.namespace
  name           = var.oci_bucket_name
  access_type    = "NoPublicAccess"

  # バケットのメタデータ
  metadata = {
    "purpose"     = "semantic-doc-search"
    "environment" = "production"
  }

  # バージョニングを有効化
  versioning = "Enabled"

  # 自動階層化を有効化(コスト最適化)
  auto_tiering = "InfrequentAccess"
}

# Dify用のバケットを作成(オプション)
resource "oci_objectstorage_bucket" "dify_storage_bucket" {
  count          = var.enable_dify ? 1 : 0
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.tenant_namespace.namespace
  name           = var.dify_bucket_name
  access_type    = "NoPublicAccess"

  # バケットのメタデータ
  metadata = {
    "purpose"     = "dify-llm-platform"
    "environment" = "production"
  }

  # バージョニングを無効化(Difyが独自に管理)
  versioning = "Disabled"

  # 自動階層化を有効化(コスト最適化)
  auto_tiering = "InfrequentAccess"
}
