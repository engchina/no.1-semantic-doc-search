# バケットネームスペース取得(デフォルトリージョン)
data "oci_objectstorage_namespace" "bucket_namespace" {
  compartment_id = var.compartment_ocid
}

# Object Storageバケットの作成(デフォルトリージョン)
resource "oci_objectstorage_bucket" "document_storage_bucket" {
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.bucket_namespace.namespace
  name           = var.oci_bucket_name
  access_type    = "NoPublicAccess"

  # バケットのメタデータ
  metadata = {
    "purpose"     = "semantic-doc-search"
    "environment" = "production"
  }

  # バージョニングを無効化(クリーンアップを容易にするため)
  versioning = "Disabled"

  # 自動階層化を有効化(コスト最適化)
  auto_tiering = "InfrequentAccess"
}

# バケット削除時のクリーンアップリソース
resource "null_resource" "document_bucket_cleanup" {
  triggers = {
    bucket_name = oci_objectstorage_bucket.document_storage_bucket.name
    namespace   = oci_objectstorage_bucket.document_storage_bucket.namespace
    region      = var.region
  }

  provisioner "local-exec" {
    when    = destroy
    command = "oci os object bulk-delete --bucket-name ${self.triggers.bucket_name} --namespace ${self.triggers.namespace} --region ${self.triggers.region} --force || true"
  }

  depends_on = [oci_objectstorage_bucket.document_storage_bucket]
}

# Dify用のバケットを作成(オプション)
resource "oci_objectstorage_bucket" "dify_storage_bucket" {
  count          = var.enable_dify ? 1 : 0
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.bucket_namespace.namespace
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

# Difyバケット削除時のクリーンアップリソース
resource "null_resource" "dify_bucket_cleanup" {
  count = var.enable_dify ? 1 : 0

  triggers = {
    bucket_name = oci_objectstorage_bucket.dify_storage_bucket[0].name
    namespace   = oci_objectstorage_bucket.dify_storage_bucket[0].namespace
    region      = var.region
  }

  provisioner "local-exec" {
    when    = destroy
    command = "oci os object bulk-delete --bucket-name ${self.triggers.bucket_name} --namespace ${self.triggers.namespace} --region ${self.triggers.region} --force || true"
  }

  depends_on = [oci_objectstorage_bucket.dify_storage_bucket]
}
