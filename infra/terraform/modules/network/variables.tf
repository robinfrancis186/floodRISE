variable "name" { type = string }
variable "vpc_cidr" { type = string }
variable "enable_nat_gateway" { type = bool }
variable "approved_adapter_egress_cidrs" { type = list(string) }
