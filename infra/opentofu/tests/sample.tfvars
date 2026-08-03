platform_name = "deploytide"

regions = {
  east-us = {
    name                      = "East US"
    provider_region           = "fixture-east-us"
    residency                 = "United States"
    build_capacity            = 2
    runtime_capacity          = 4
    architecture              = "amd64"
    runtime_cluster_id        = "runtime-cluster-exact-east-us"
    runtime_target_id         = "runtime-target-exact-east-us"
    controller_enrollment_url = "https://pki.internal.deploytide.test/v1/controllers/enroll"
  }
  uk-south = {
    name                      = "UK South"
    provider_region           = "fixture-uk-south"
    residency                 = "United Kingdom"
    build_capacity            = 0
    runtime_capacity          = 4
    architecture              = "amd64"
    runtime_cluster_id        = "runtime-cluster-exact-uk-south"
    runtime_target_id         = "runtime-target-exact-uk-south"
    controller_enrollment_url = "https://pki.internal.deploytide.test/v1/controllers/enroll"
  }
}

runtime_enrollment_tokens = {
  east-us  = "fixture_one_time_token_east_us_000000000000000000000000"
  uk-south = "fixture_one_time_token_uk_south_111111111111111111111111"
}

controller_image   = "ghcr.io/mayowaoladosu/deploytide-runtime-controller@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
docker_proxy_image = "ghcr.io/mayowaoladosu/deploytide-docker-proxy@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
control_plane_url  = "https://operator.internal.deploytide.test"
mtls_server_name   = "operator.internal.deploytide.test"

controller_ca_pem = <<-EOT
-----BEGIN CERTIFICATE-----
MIIDNzCCAh+gAwIBAgIUZd5zwQJeXJetgwNbse0Tofp/xwQwDQYJKoZIhvcNAQEL
BQAwKzEpMCcGA1UEAwwgRGVwbG95VGlkZSBDbG91ZCBJbml0IEZpeHR1cmUgQ0Ew
HhcNMjYwODAzMDQ1NjU3WhcNMzYwNzMxMDQ1NjU3WjArMSkwJwYDVQQDDCBEZXBs
b3lUaWRlIENsb3VkIEluaXQgRml4dHVyZSBDQTCCASIwDQYJKoZIhvcNAQEBBQAD
ggEPADCCAQoCggEBALMNjQh7HafawB2ggGLO2Fw6UzFEoU4e8kxG4GKQ72L+FJg1
PtU4JL0U0FNXhQg3l1qOy0LcjRRrRcNxP/tV5z8VNid85SlifZIepX6yibA3fhGO
PvRVj4YVn+q03F+fnC1Xyw9DWXGUuaIfzKVeZ9xldBFCQa29L4LMsvj+VZQdUX+t
c2XMgWL3gYk6Ll+JH2vVBnBxsLdZZsxtE+cNo77EcNOufozpRD1hrO2Cs5RgZ+iV
glYukpvCosK6jpkJal6RzKfMYUWdP/8XZ7fgrpo+Jw9axTPtrOc57OvNRMlBJzAD
rNMwAU/pjM4e+CtOKz0aBSCCNY/KQmcqW4kirI8CAwEAAaNTMFEwHQYDVR0OBBYE
FNxFa5bVMvDAoaDCE4Pib3ZUUAi+MB8GA1UdIwQYMBaAFNxFa5bVMvDAoaDCE4Pi
b3ZUUAi+MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBALCeMhVZ
/7292y7gzszlErifE20WCGlLwx9QrOphG9rRzLhrYXlUXaVWfsvCvd2czMQ0fc6E
W/lc441EiMtozcEPR6E0oVQXMQgkpsi2w8eLnZc3GI/0SFOwaAQyIVh7ayN/vGwB
smxvEpR1U+jO9pQNTPn7bQfifWrDNK82h9iOJmJLB6ll9vVpo29ACy2C13F/w2ws
GTSB8igJpVRCb2qde/TLYPO1XqNortWFRaTGQjaBEtdQFUKJ1/TgWLqUlZ4stMno
QUdDZNZo560M1Ldp32pSGxsTIUOd0jDg126XFvyAfqiEAVRkswUDua+c9JzF1lbO
S5vxYTX0UrwF2K0=
-----END CERTIFICATE-----
EOT

job_public_key_pem = <<-EOT
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAzPbYE2LYh5ero3bCkHulTS4Fv/FWmo4fa8yxWQc0jbI=
-----END PUBLIC KEY-----
EOT
