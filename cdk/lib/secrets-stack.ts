import * as cdk from "aws-cdk-lib";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export class SecretsStack extends cdk.Stack {
  public readonly telegramBotToken: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.telegramBotToken = new secretsmanager.Secret(this, "TelegramBotToken", {
      secretName: "franklin/telegram-bot-token",
      description: "Telegram bot token for Franklin",
    });

    new cdk.CfnOutput(this, "TelegramBotTokenArn", {
      value: this.telegramBotToken.secretArn,
      description: "ARN of the Franklin Telegram bot token secret",
      exportName: "FranklinTelegramBotTokenArn",
    });
  }
}
