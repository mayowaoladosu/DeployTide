# Operate build and runtime capacity as separate planes

DeployTide keeps operator-owned build capacity independent from operator-owned runtime capacity. Builds are bursty, privileged, and disposable; runtimes are traffic-serving and availability-sensitive. Separating the planes adds scheduling and artifact-transfer boundaries, but allows each risk profile and capacity pool to scale without coupling customer traffic to build demand.
