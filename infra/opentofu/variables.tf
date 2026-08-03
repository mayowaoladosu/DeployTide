variable "platform_name" {
  description = "Stable operator-owned platform identifier."
  type        = string
  default     = "deploytide"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,31}$", var.platform_name))
    error_message = "platform_name must be a short DNS-safe identifier."
  }
}

variable "regions" {
  description = "Operator-approved region instances. Runtime IDs are exact control-plane records; enrollment URLs issue node-generated client certificates."
  type = map(object({
    name                      = string
    provider_region           = string
    residency                 = string
    build_capacity            = number
    runtime_capacity          = number
    architecture              = string
    runtime_cluster_id        = string
    runtime_target_id         = string
    controller_enrollment_url = string
  }))

  validation {
    condition = (
      length(var.regions) >= 2 &&
      alltrue([
        for code, region in var.regions :
        can(regex("^[a-z0-9]+(?:-[a-z0-9]+)*$", code)) &&
        contains(["amd64", "arm64"], region.architecture) &&
        region.runtime_capacity > 0 &&
        region.build_capacity >= 0 &&
        can(regex("^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,191}$", region.runtime_cluster_id)) &&
        can(regex("^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,191}$", region.runtime_target_id)) &&
        can(regex("^https://[^[:space:]@]+$", region.controller_enrollment_url))
      ]) &&
      length(distinct([for region in values(var.regions) : region.runtime_cluster_id])) == length(var.regions) &&
      length(distinct([for region in values(var.regions) : region.runtime_target_id])) == length(var.regions)
    )
    error_message = "Two unique, valid runtime region instances with exact IDs and HTTPS enrollment URLs are required."
  }
}

variable "runtime_enrollment_tokens" {
  description = "Per-region PKI bootstrap tokens. They transit sensitive OpenTofu state and user-data, so the issuer must enforce short expiry, one-time use, exact cluster/target binding, and rotation for every reprovisioning operation."
  type        = map(string)
  sensitive   = true

  validation {
    condition = length(var.runtime_enrollment_tokens) >= 2 && alltrue([
      for token in values(var.runtime_enrollment_tokens) :
      can(regex("^[A-Za-z0-9_-]{32,512}$", token))
    ])
    error_message = "Enrollment tokens must be 32-512 character base64url values."
  }
}

variable "controller_image" {
  description = "Digest-pinned runtime-controller image."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}@sha256:[0-9a-f]{64}$", var.controller_image))
    error_message = "controller_image must be pinned by sha256 digest."
  }
}

variable "docker_proxy_image" {
  description = "Digest-pinned constrained Docker Unix-socket proxy image."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}@sha256:[0-9a-f]{64}$", var.docker_proxy_image))
    error_message = "docker_proxy_image must be pinned by sha256 digest."
  }
}

variable "buildkit_image" {
  description = "Digest-pinned rootless BuildKit image."
  type        = string
  default     = "moby/buildkit@sha256:0c0ce4929976ace509f7a53878303504b2de8857829aea4932af9f7325a30f51"

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}@sha256:[0-9a-f]{64}$", var.buildkit_image))
    error_message = "buildkit_image must be pinned by sha256 digest."
  }
}

variable "control_plane_url" {
  description = "Internal HTTPS control-plane endpoint contacted outbound by controllers."
  type        = string

  validation {
    condition     = can(regex("^https://[^[:space:]@]+$", var.control_plane_url))
    error_message = "control_plane_url must be a credential-free HTTPS URL."
  }
}

variable "controller_ca_pem" {
  description = "Public operator CA bundle used for PKI enrollment verification and controller mTLS."
  type        = string

  validation {
    condition = (
      startswith(trimspace(var.controller_ca_pem), "-----BEGIN CERTIFICATE-----") &&
      !strcontains(var.controller_ca_pem, "PRIVATE KEY")
    )
    error_message = "controller_ca_pem must contain public PEM certificates only."
  }
}

variable "job_public_key_pem" {
  description = "Ed25519 key used by controllers to verify typed jobs."
  type        = string

  validation {
    condition = (
      startswith(trimspace(var.job_public_key_pem), "-----BEGIN PUBLIC KEY-----") &&
      !strcontains(var.job_public_key_pem, "PRIVATE KEY")
    )
    error_message = "job_public_key_pem must contain public PEM key material only."
  }
}

variable "mtls_server_name" {
  description = "TLS server name presented by the operator controller ingress."
  type        = string

  validation {
    condition     = can(regex("^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$", var.mtls_server_name))
    error_message = "mtls_server_name must be a valid DNS name."
  }
}

variable "docker_api_version" {
  description = "Single Docker API version shared by the controller and constrained proxy policy."
  type        = string
  default     = "v1.47"

  validation {
    condition     = can(regex("^v1\\.[0-9]{2}$", var.docker_api_version))
    error_message = "docker_api_version must use the v1.NN form."
  }
}
