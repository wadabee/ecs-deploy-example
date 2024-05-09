#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { FrontendStack } from "../lib/frontend-stack";
import { BackendStack } from "../lib/backend-stack";

const app = new cdk.App();

const backend = new BackendStack(app, "ExampleBackendStack");

new FrontendStack(app, "ExampleFrontendStack", {
  userPoolId: backend.userPoolId,
  userPoolClientId: backend.userPoolClientId,
  identityPoolId: backend.identityPoolId,
  apiEndpoint: backend.webApiUrl,
});
