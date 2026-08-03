locals {
  runtime_regions = {
    for code, region in var.regions : code => region
    if region.runtime_capacity > 0
  }
  build_regions = {
    for code, region in var.regions : code => region
    if region.build_capacity > 0
  }
}

check "runtime_enrollment_token_keys" {
  assert {
    condition = (
      length(setsubtract(toset(keys(local.runtime_regions)), toset(keys(var.runtime_enrollment_tokens)))) == 0 &&
      length(setsubtract(toset(keys(var.runtime_enrollment_tokens)), toset(keys(local.runtime_regions)))) == 0
    )
    error_message = "runtime_enrollment_tokens must contain exactly one token for every runtime region."
  }
}

data "cloudinit_config" "runtime" {
  for_each      = local.runtime_regions
  gzip          = true
  base64_encode = true

  part {
    content_type = "text/cloud-config"
    content = templatefile("${path.module}/templates/runtime-cloud-init.yaml.tftpl", {
      runtime_cluster_id     = each.value.runtime_cluster_id
      runtime_target_id      = each.value.runtime_target_id
      runtime_cluster_id_b64 = base64encode(each.value.runtime_cluster_id)
      runtime_target_id_b64  = base64encode(each.value.runtime_target_id)
      enrollment_url_b64     = base64encode(each.value.controller_enrollment_url)
      enrollment_token_b64   = base64encode(lookup(var.runtime_enrollment_tokens, each.key, ""))
      controller_image       = var.controller_image
      docker_proxy_image     = var.docker_proxy_image
      docker_api_version     = var.docker_api_version
      control_plane_url      = var.control_plane_url
      mtls_server_name       = var.mtls_server_name
      controller_ca_pem_b64  = base64encode(trimspace(var.controller_ca_pem))
      job_public_key_pem_b64 = base64encode(trimspace(var.job_public_key_pem))
    })
  }
}

data "cloudinit_config" "build" {
  for_each      = local.build_regions
  gzip          = true
  base64_encode = true

  part {
    content_type = "text/cloud-config"
    content = templatefile("${path.module}/templates/build-cloud-init.yaml.tftpl", {
      buildkit_image = var.buildkit_image
      build_host_contract_b64 = base64encode(jsonencode({
        format                    = "deploytide.rootless-buildkit-host.v1"
        platform                  = var.platform_name
        region                    = each.key
        architecture              = each.value.architecture
        maxCapacity               = each.value.build_capacity
        orchestrator              = "RootlessBuildKitProvider"
        image                     = var.buildkit_image
        ephemeralWorkers          = true
        scrubAfterLease           = true
        workerContainerPrivileged = true
        securityOptions           = ["seccomp=unconfined", "apparmor=unconfined"]
        requiredHostFeatures      = ["docker", "user-namespaces", "fuse-overlayfs", "uidmap"]
      }))
    })
  }
}

resource "local_sensitive_file" "runtime_cloud_init" {
  for_each        = data.cloudinit_config.runtime
  filename        = "${path.module}/generated/runtime-${each.key}.cloud-init.b64"
  content         = each.value.rendered
  file_permission = "0600"
}

resource "local_sensitive_file" "build_cloud_init" {
  for_each        = data.cloudinit_config.build
  filename        = "${path.module}/generated/build-${each.key}.cloud-init.b64"
  content         = each.value.rendered
  file_permission = "0600"
}

output "region_contract" {
  description = "Provider-neutral records consumed by the DeployTide operator API."
  value = {
    for code, region in var.regions : code => {
      code               = code
      name               = region.name
      provider_mapping   = region.provider_region
      residency          = region.residency
      architecture       = region.architecture
      build_available    = region.build_capacity > 0
      runtime_available  = region.runtime_capacity > 0
      runtime_cluster_id = region.runtime_cluster_id
      runtime_target_id  = region.runtime_target_id
      enrollment_url     = region.controller_enrollment_url
    }
  }
}

output "runtime_cloud_init_paths" {
  value     = { for code, file in local_sensitive_file.runtime_cloud_init : code => file.filename }
  sensitive = true
}

output "build_cloud_init_paths" {
  value     = { for code, file in local_sensitive_file.build_cloud_init : code => file.filename }
  sensitive = true
}
