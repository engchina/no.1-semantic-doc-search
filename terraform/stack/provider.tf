provider "oci" {
  region = var.deploy_region
}

provider "oci" {
  alias  = "deploy_region"
  region = var.deploy_region
}
