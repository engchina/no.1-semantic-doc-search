variable "availability_domain" {
  default = "bxtG:AP-OSAKA-1-AD-1"
}

variable "compartment_ocid" {
  default = ""
}

variable "adb_name" {
  default = "AIDOCADB"
}

variable "adb_password" {
  default = ""
}

variable "license_model" {
  default = ""
}

variable "instance_display_name" {
  default = "AIDOC_INSTANCE"
}

variable "instance_shape" {
  default = "VM.Standard.E4.Flex"
}

variable "instance_flex_shape_ocpus" {
  default = 2
}

variable "instance_flex_shape_memory" {
  default = 16
}

variable "instance_boot_volume_size" {
  default = 100
}

variable "instance_boot_volume_vpus" {
  default = 20
}

variable "instance_image_source_id" {
  default = "ocid1.image.oc1.ap-osaka-1.aaaaaaaa7sbmd5q54w466eojxqwqfvvp554awzjpt2behuwsiefrxnwomq5a"
}

variable "subnet_ai_subnet_id" {
  default = ""
}

variable "ssh_authorized_keys" {
  default = ""
}

variable "oci_bucket_name" {
  default     = "semantic-doc-search"
  description = "OCI Object Storage bucket name for document storage"
}

variable "enable_dify" {
  description = "Difyのインストールを有効化"
  type        = bool
  default     = false
}

variable "dify_bucket_name" {
  description = "Dify専用のOCI Object Storageバケット名"
  type        = string
  default     = "dify-bucket"
}

variable "dify_branch" {
  description = "Difyリポジトリのブランチまたはタグ名"
  type        = string
  default     = "1.11.4"
}

variable "bucket_region" {
  description = "Object Storageバケットのリージョン"
  type        = string
  default     = "ap-osaka-1"
}

variable "oci_access_key" {
  description = "OCI Object Storage Access Key (S3互換性用)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "oci_secret_key" {
  description = "OCI Object Storage Secret Key (S3互換性用)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "external_api_keys" {
  description = "外部APIアクセス用のAPIキー（カンマ区切りで複数指定可能）"
  type        = string
  default     = ""
  sensitive   = true
}