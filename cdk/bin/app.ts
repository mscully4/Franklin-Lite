#!/usr/bin/env npx tsx
import { App } from "aws-cdk-lib";
import { SecretsStack } from "../lib/secrets-stack.js";
import process from "process";

const app = new App();

new SecretsStack(app, "FranklinSecrets", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: "Franklin — secrets and API keys",
});
