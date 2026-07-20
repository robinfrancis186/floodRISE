#!/usr/bin/env sh
set -eu

region="ap-south-1"
raw_bucket="floodrise-demo-raw"
processed_bucket="floodrise-demo-processed"
dead_letter_queue="floodrise-demo-jobs-dlq"
jobs_queue="floodrise-demo-jobs"

awslocal s3api create-bucket \
  --bucket "${raw_bucket}" \
  --region "${region}" \
  --create-bucket-configuration LocationConstraint="${region}" 2>/dev/null || true
awslocal s3api create-bucket \
  --bucket "${processed_bucket}" \
  --region "${region}" \
  --create-bucket-configuration LocationConstraint="${region}" 2>/dev/null || true

awslocal s3api put-public-access-block \
  --bucket "${raw_bucket}" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
awslocal s3api put-public-access-block \
  --bucket "${processed_bucket}" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

dlq_url="$(awslocal sqs create-queue --queue-name "${dead_letter_queue}" --query QueueUrl --output text)"
dlq_arn="$(awslocal sqs get-queue-attributes --queue-url "${dlq_url}" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"
redrive_policy="{\"deadLetterTargetArn\":\"${dlq_arn}\",\"maxReceiveCount\":\"3\"}"
queue_attributes="$(python -c 'import json, sys; print(json.dumps({"RedrivePolicy": sys.argv[1], "VisibilityTimeout": "120"}))' "${redrive_policy}")"
awslocal sqs create-queue \
  --queue-name "${jobs_queue}" \
  --attributes "${queue_attributes}" >/dev/null
