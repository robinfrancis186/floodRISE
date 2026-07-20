variable "name" { type = string }
variable "vpc_cidr" { type = string }
variable "enable_nat_gateway" { type = bool }
variable "allow_public_egress" { type = bool }
variable "allowed_ingress_cidrs" { type = list(string) }
