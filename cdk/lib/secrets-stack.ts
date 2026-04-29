import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export class SecretsStack extends Stack {
  public readonly telegramBotToken: Secret;
  public readonly discordBotToken: Secret;

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

    this.discordBotToken = new Secret(this, "DiscordBotToken", {
      secretName: "franklin/discord-bot-token",
      description: "Discord bot token for Franklin",
    });

    new CfnOutput(this, "DiscordBotTokenArn", {
      value: this.discordBotToken.secretArn,
      description: "ARN of the Franklin Discord bot token secret",
      exportName: "FranklinDiscordBotTokenArn",
    });
  }
}
