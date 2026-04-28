#!/usr/bin/env npx tsx
import * as cdk from "aws-cdk-lib";
import { SecretsStack } from "../lib/secrets-stack.js";

const app = new cdk.App();

new SecretsStack(app, "FranklinSecrets", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: "Franklin — secrets and API keys",
});
