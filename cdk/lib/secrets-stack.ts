import { App, CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export class SecretsStack extends Stack {
  public readonly telegramBotToken: Secret;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.telegramBotToken = new Secret(this, "TelegramBotToken", {
      secretName: "franklin/telegram-bot-token",
      description: "Telegram bot token for Franklin",
    });

    new CfnOutput(this, "TelegramBotTokenArn", {
      value: this.telegramBotToken.secretArn,
      description: "ARN of the Franklin Telegram bot token secret",
      exportName: "FranklinTelegramBotTokenArn",
    });
  }
}
