import { Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import {
  AuthorizationType,
  CognitoUserPoolsAuthorizer,
  ConnectionType,
  Cors,
  Integration,
  IntegrationType,
  Model,
  ResponseType,
  RestApi,
  VpcLink,
} from "aws-cdk-lib/aws-apigateway";

import { UserPool } from "aws-cdk-lib/aws-cognito";
import {
  BastionHostLinux,
  BlockDeviceVolume,
  InstanceClass,
  InstanceSize,
  InstanceType,
  IpAddresses,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  ContainerImage,
  FargateService,
  FargateTaskDefinition,
  LogDrivers,
} from "aws-cdk-lib/aws-ecs";
import { NetworkLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {
  Credentials,
  DatabaseInstance,
  DatabaseInstanceEngine,
  PostgresEngineVersion,
} from "aws-cdk-lib/aws-rds";
import { Construct } from "constructs";
import {
  IdentityPool,
  UserPoolAuthenticationProvider,
} from "@aws-cdk/aws-cognito-identitypool-alpha";
import path = require("path");
import { LogGroup } from "aws-cdk-lib/aws-logs";

export class BackendStack extends Stack {
  public readonly userPoolId: string;
  public readonly userPoolClientId: string;
  public readonly identityPoolId: string;
  public readonly webApiUrl: string;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ******** Cognitoの定義 ********
    // Cognito UserPool を作成（サービスを利用するユーザアカウントのプール）
    const userPool = new UserPool(this, "UserPool", {
      // ユーザー登録機能を無効化
      selfSignUpEnabled: false,
      // メールアドレスをユーザー ID に設定
      signInAliases: {
        email: true,
        username: false,
      },
    });

    // Cognito UserPool を利用する Client を作成（フロントエンド用）
    const userPoolClientForWeb = userPool.addClient("UserPoolClientForWeb", {
      accessTokenValidity: Duration.days(1),
      idTokenValidity: Duration.days(1),
      refreshTokenValidity: Duration.days(30),
    });

    const idPool = new IdentityPool(this, "IdentityPool", {
      authenticationProviders: {
        userPools: [
          new UserPoolAuthenticationProvider({
            userPool,
            userPoolClient: userPoolClientForWeb,
          }),
        ],
      },
    });

    // VPC作成
    const vpc = new Vpc(this, "Vpc", {
      ipAddresses: IpAddresses.cidr("10.0.0.0/16"),
      // AZの数を定義
      maxAzs: 2,

      subnetConfiguration: [
        // Publicサブネット
        // Public IPアドレスが自動割り当てされないように設定
        {
          name: "PublicSubnet",
          subnetType: SubnetType.PUBLIC,
          mapPublicIpOnLaunch: false,
        },
        // Privateサブネット
        // NAT Gatewayを通じて、PrivateサブネットからInternetへ通信が行える設定とする
        {
          name: "PrivateSubnet",
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // ******** データベースの定義 ********
    // セキュリティグループの定義
    const databaseSG = new SecurityGroup(this, "DatabaseSecurityGroup", {
      vpc,
    });
    // 内部からのアクセスのみ許可
    databaseSG.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(5432));

    // RDS作成
    const rdsInstance = new DatabaseInstance(this, "Rdb", {
      engine: DatabaseInstanceEngine.postgres({
        version: PostgresEngineVersion.VER_15_4,
      }),
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MEDIUM),
      allocatedStorage: 20,
      storageEncrypted: true,

      // プライベートサブネットに配置
      vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
      publiclyAccessible: false,

      securityGroups: [databaseSG],
      port: 5432,

      // 認証情報を生成して、Secret Managerに保存
      credentials: Credentials.fromGeneratedSecret("example"),

      // PostgreSQLのデータベース名
      databaseName: "example",

      multiAz: false,
    });

    // DBに接続するための踏み台を設定
    // SessionManagerを使って接続するため、プライベートサブネットに配置
    // アクセス制限やIP制限を行いたい場合は、IAMポリシーを利用して行うこと（SessionManagerの権限で制御）
    new BastionHostLinux(this, "Bastion", {
      vpc,
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: BlockDeviceVolume.ebs(8, {
            encrypted: true,
          }),
        },
      ],
    });

    // APIの定義
    const logGroup = new LogGroup(this, "ApiContainerLogGroup", {
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const cluster = new Cluster(this, "BackendApiCluster", {
      vpc,
    });

    const taskDef = new FargateTaskDefinition(this, "FargateTaskDef", {
      cpu: 512,
      memoryLimitMiB: 2048,
    });
    taskDef.addContainer("ApiContainer", {
      image: ContainerImage.fromAsset("../app", {
        file: "./api.Dockerfile",
      }),
      logging: LogDrivers.awsLogs({
        streamPrefix: "ApiContainer",
        logGroup,
      }),
      environment: {
        SECRET_ARN: rdsInstance.secret?.secretArn ?? "",
      },
      portMappings: [
        {
          containerPort: 3000,
        },
      ],
    });

    // ECSサービスのセキュリティグループを定義
    // コンテナでListenしているポートの通信を許可する必要がある
    const fargateServiceSg = new SecurityGroup(this, "FargateServiceSG", {
      vpc,
      allowAllOutbound: true,
    });
    fargateServiceSg.addIngressRule(Peer.anyIpv4(), Port.tcp(3000));
    fargateServiceSg.addIngressRule(Peer.anyIpv4(), Port.tcp(3001));

    const fargateService = new FargateService(this, "BackendApiService", {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      securityGroups: [fargateServiceSg],
    });
    rdsInstance.secret?.grantRead(taskDef.taskRole);

    const nlb = new NetworkLoadBalancer(this, "NetworkLoadBlancer", {
      vpc,
      internetFacing: false,
    });
    const webApiListener = nlb.addListener("WebApiListener", {
      port: 80,
    });
    webApiListener.addTargets("WebApiTargets", {
      port: 3000,
      targets: [
        fargateService.loadBalancerTarget({
          containerName: "ApiContainer",
          containerPort: 3000,
        }),
      ],
    });

    const vpcLink = new VpcLink(this, "ApiGwVpcLink", {
      targets: [nlb],
    });

    const api = new RestApi(this, "ApiGwRestApi", {
      deployOptions: {
        stageName: "api",
      },
      defaultCorsPreflightOptions: {
        allowOrigins: Cors.ALL_ORIGINS,
        allowMethods: Cors.ALL_METHODS,
      },
      cloudWatchRole: true,
    });
    api.addGatewayResponse("Api4XX", {
      type: ResponseType.DEFAULT_4XX,
      responseHeaders: {
        "Access-Control-Allow-Origin": "'*'",
      },
    });

    api.addGatewayResponse("Api5XX", {
      type: ResponseType.DEFAULT_5XX,
      responseHeaders: {
        "Access-Control-Allow-Origin": "'*'",
      },
    });

    const vpcIntegration = new Integration({
      type: IntegrationType.HTTP_PROXY,
      integrationHttpMethod: "ANY",
      uri: `http://${nlb.loadBalancerDnsName}/{proxy}`,
      options: {
        connectionType: ConnectionType.VPC_LINK,
        requestParameters: {
          "integration.request.path.proxy": "method.request.path.proxy",
        },
        vpcLink,
      },
    });

    const authorizer = new CognitoUserPoolsAuthorizer(this, "Authorizer", {
      cognitoUserPools: [userPool],
    });

    api.root.addProxy({
      defaultIntegration: vpcIntegration,
      defaultMethodOptions: {
        requestParameters: {
          "method.request.path.proxy": true,
        },
        authorizationType: AuthorizationType.COGNITO,
        authorizer,
        methodResponses: [
          {
            statusCode: "200",
            responseModels: {
              "application/json": Model.EMPTY_MODEL,
            },
            responseParameters: {
              "method.response.header.Access-Control-Allow-Origin": true,
            },
          },
        ],
      },
    });
    this.userPoolId = userPool.userPoolId;
    this.identityPoolId = idPool.identityPoolId;
    this.userPoolClientId = userPoolClientForWeb.userPoolClientId;
    this.webApiUrl = api.url;
  }
}
