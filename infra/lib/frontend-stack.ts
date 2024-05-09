import { CfnOutput, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import {
  CloudFrontWebDistribution,
  OriginAccessIdentity,
} from "aws-cdk-lib/aws-cloudfront";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { NodejsBuild } from "deploy-time-build";
import path = require("path");

type Props = StackProps & {
  apiEndpoint: string;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
};

export class FrontendStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    // SPAのプログラムを格納するためのS3バケット
    const websiteBucket = new Bucket(this, "FrontendBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // OAIの定義
    const websiteIdentity = new OriginAccessIdentity(this, "WebsiteIdentity");
    // SPAを配信するために読み取り許可
    websiteBucket.grantRead(websiteIdentity);

    // CloudFrontディストリビューションの定義
    const distribution = new CloudFrontWebDistribution(this, "FrontendDist", {
      // 404エラーが発生しても、index.htmlをレスポンスとして返す
      // 404エラーの制御はフロントエンドのプログラムで実施する
      // ※SPAはindex.htmlしか存在しないため
      errorConfigurations: [
        {
          errorCachingMinTtl: 300,
          errorCode: 404,
          responseCode: 200,
          responsePagePath: "/index.html",
        },
      ],

      // S3をオリジンとして配信する
      originConfigs: [
        {
          s3OriginSource: {
            s3BucketSource: websiteBucket,
            originAccessIdentity: websiteIdentity,
          },
          behaviors: [
            {
              isDefaultBehavior: true,
            },
          ],
        },
      ],

      // // WAFの設定
      // webACLId: props?.webAclArn.value,
    });

    new NodejsBuild(this, "BuildWeb", {
      assets: [
        {
          path: "../app",
          exclude: [
            ".git",
            ".gitignore",
            "*.md",
            "LICENSE",
            "node_modules",
            "api.Dockerfile",
            "docker-compose.yml",
            "packages/web/dist",
          ],
        },
      ],
      destinationBucket: websiteBucket,
      distribution: distribution,
      outputSourceDirectory: "./packages/web/dist",
      buildCommands: ["npm ci", "npm run web:build"],
      buildEnvironment: {
        VITE_APP_API_ENDPOINT: props.apiEndpoint,
        VITE_APP_USER_POOL_ID: props.userPoolId,
        VITE_APP_USER_POOL_CLIENT_ID: props.userPoolClientId,
        VITE_APP_IDENTITY_POOL_ID: props.identityPoolId,
      },
    });

    // CloudFront の URL を出力
    new CfnOutput(this, "WebURL", {
      description: "WebURL",
      value: `https://${distribution.distributionDomainName}`,
    });
  }
}
