terraform {
  backend "s3" {
    bucket = "miniapp-tfstate"
    key    = "prod/terraform.tfstate"
    region = "eu-west-1"

    use_lockfile = true
  }
}

variable "environment" {
  type        = string
  description = "Deployment environment name."
}

variable "instance_count" {
  type    = number
  default = 2
}

data "aws_caller_identity" "current" {}

resource "aws_db_instance" "primary" {
  identifier     = "miniapp-${var.environment}"
  engine         = "postgres"
  instance_class = "db.t4g.micro"

  # A string containing an interpolation that itself contains quotes. The block
  # scanner has to treat this as one string, or brace depth desynchronises and
  # every block after it is lost.
  tags = {
    Name  = "[${join(", ", formatlist("\"%s\"", ["miniapp", var.environment]))}]"
    Owner = data.aws_caller_identity.current.account_id
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_db_subnet_group" "primary" {
  name = "miniapp-${var.environment}"

  policy = <<-EOT
    { "Version": "2012-10-17", "Statement": [{ "Effect": "Allow" }] }
  EOT
}

module "network" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.13.0"

  name = "miniapp-${var.environment}"
}
