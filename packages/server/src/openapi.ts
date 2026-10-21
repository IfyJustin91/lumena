export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Lumen Server API",
    description:
      "API specification and documentation portal for @lumen/server co-signing, fee sponsorship, and policy engine services.",
    version: "0.1.0",
  },
  servers: [
    {
      url: "http://localhost:3000",
      description: "Local development server",
    },
  ],
  paths: {
    "/health": {
      get: {
        summary: "Health Check",
        description:
          "Returns the operational status of the server and the configured Stellar network.",
        responses: {
          "200": {
            description: "Server is healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    network: { type: "string", example: "testnet" },
                  },
                  required: ["status", "network"],
                },
              },
            },
          },
        },
      },
    },
    "/auth/challenge": {
      get: {
        summary: "SEP-10 Challenge",
        description:
          "Generates a SEP-10 challenge transaction envelope signed by the server for the given Stellar account. " +
          "The client must sign the challenge transaction and submit it to POST /auth/token to obtain a JWT.",
        security: [],
        parameters: [
          {
            name: "account",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "Stellar public key (G...) of the account requesting authentication.",
            example: "GAD7654...",
          },
        ],
        responses: {
          "200": {
            description: "SEP-10 challenge transaction envelope",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    transaction: {
                      type: "string",
                      description: "Base64 encoded challenge transaction envelope XDR.",
                      example: "AAAAAG...",
                    },
                    network_passphrase: {
                      type: "string",
                      description: "Stellar network passphrase the challenge is valid for.",
                      example: "Test SDF Network ; September 2015",
                    },
                  },
                  required: ["transaction", "network_passphrase"],
                },
              },
            },
          },
          "400": { description: "Missing or invalid account parameter" },
        },
      },
    },
    "/auth/token": {
      post: {
        summary: "SEP-10 Token Exchange",
        description:
          "Validates the client signature on a SEP-10 challenge transaction and issues a JWT valid for 24 hours.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  transaction: {
                    type: "string",
                    description: "Base64 encoded signed challenge transaction envelope XDR.",
                    example: "AAAAAG...",
                  },
                },
                required: ["transaction"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "JWT issued successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    token: {
                      type: "string",
                      description: "Signed JWT valid for 24 hours.",
                      example: "eyJhbGciOi...",
                    },
                  },
                  required: ["token"],
                },
              },
            },
          },
          "400": { description: "Invalid or malformed challenge transaction" },
          "401": { description: "Challenge signature verification failed or challenge expired" },
        },
      },
    },
    "/cosign": {
      post: {
        summary: "Cosign Transaction",
        description:
          "Validates transaction operations against active policy rules and appends co-signer signature if approved.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  xdr: {
                    type: "string",
                    description: "Base64 encoded Stellar transaction envelope XDR.",
                    example: "AAAAAG...",
                  },
                  walletAddress: {
                    type: "string",
                    description: "Stellar public key address of the originating wallet.",
                    example: "GAD7654...",
                  },
                },
                required: ["xdr", "walletAddress"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Transaction approved and co-signed",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    signedXdr: { type: "string", example: "AAAAAG..." },
                  },
                  required: ["signedXdr"],
                },
              },
            },
          },
          "400": { description: "Invalid request validation error" },
          "401": { description: "Missing or invalid tenant API key" },
          "403": { description: "Transaction denied by policy rules" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
    },
    "/cosign/batch": {
      post: {
        summary: "Batch Cosign Transactions",
        description:
          "Validates and co-signs multiple transactions in a single request. Policies are evaluated atomically across all items; the response reports per-item results, including item-level policy failures.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  transactions: {
                    type: "array",
                    description: "Transactions to evaluate and co-sign.",
                    minItems: 1,
                    items: {
                      type: "object",
                      properties: {
                        xdr: {
                          type: "string",
                          description: "Base64 encoded Stellar transaction envelope XDR.",
                          example: "AAAAAG...",
                        },
                        walletAddress: {
                          type: "string",
                          description: "Stellar public key address of the originating wallet.",
                          example: "GAD7654...",
                        },
                      },
                      required: ["xdr", "walletAddress"],
                    },
                  },
                },
                required: ["transactions"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Batch processed; per-item results returned",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    results: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          index: {
                            type: "integer",
                            description: "Position of the item in the request array.",
                            example: 0,
                          },
                          signedXdr: {
                            type: "string",
                            description: "Co-signed XDR, present when approved.",
                            example: "AAAAAG...",
                          },
                          approved: { type: "boolean", example: true },
                          reason: {
                            type: "string",
                            description: "Human-readable explanation when not approved.",
                            example: "Transaction denied by policy rules",
                          },
                          code: {
                            type: "string",
                            description: "Machine-readable error code when not approved.",
                            example: "POLICY_DENIED",
                          },
                        },
                        required: ["index", "approved"],
                      },
                    },
                  },
                  required: ["results"],
                },
              },
            },
          },
          "400": { description: "Invalid request validation error" },
          "401": { description: "Missing or invalid tenant API key" },
          "403": { description: "Batch denied by policy or fraud rules" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
    },
    "/fee-bump": {
      post: {
        summary: "Wrap Fee-Bump Transaction",
        description:
          "Wraps a transaction envelope in a FeeBumpTransaction signed by the fee sponsor account.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  xdr: {
                    type: "string",
                    description: "Base64 encoded Stellar transaction envelope XDR to wrap.",
                    example: "AAAAAG...",
                  },
                },
                required: ["xdr"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Fee bump transaction wrapped successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    feeBumpXdr: { type: "string", example: "AAAAAG..." },
                  },
                  required: ["feeBumpXdr"],
                },
              },
            },
          },
          "401": { description: "Missing or invalid tenant API key" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
    },
    "/fee-bump/submit": {
      post: {
        summary: "Submit Fee-Bump Transaction",
        description:
          "Wraps and immediately submits a transaction to the Stellar network using the fee sponsor account.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  xdr: {
                    type: "string",
                    description: "Base64 encoded Stellar transaction envelope XDR.",
                    example: "AAAAAG...",
                  },
                },
                required: ["xdr"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Transaction submitted successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    hash: { type: "string", example: "7f3b..." },
                    successful: { type: "boolean", example: true },
                  },
                },
              },
            },
          },
          "401": { description: "Missing or invalid tenant API key" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
    },
    "/wallets": {
      get: {
        summary: "List Registered Wallets",
        description:
          "Returns all wallet addresses registered in the WalletRegistry. Protected by API key authentication. Supports pagination via limit and offset query parameters.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            description: "Maximum number of wallets to return.",
          },
          {
            name: "offset",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 0, default: 0 },
            description: "Number of wallets to skip for pagination.",
          },
        ],
        responses: {
          "200": {
            description: "List of registered wallet addresses",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    wallets: {
                      type: "array",
                      items: { type: "string" },
                      example: ["GAD7654...", "GCB2..."],
                    },
                    total: { type: "integer", example: 10 },
                  },
                  required: ["wallets", "total"],
                },
              },
            },
          },
          "401": { description: "Missing or invalid tenant API key" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
    },
    "/wallet/create": {
      post: {
        summary: "Create Seedless Wallet",
        description:
          "Provisions a new sponsored Stellar account with multi-signature key configuration.",
        responses: {
          "200": {
            description: "Wallet created successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    address: { type: "string", example: "GAD7654..." },
                    publicKey: { type: "string", example: "GAD7654..." },
                  },
                  required: ["address", "publicKey"],
                },
              },
            },
          },
          "401": { description: "Missing or invalid tenant API key" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
    },
    "/wallet/{address}/transactions": {
      get: {
        summary: "Get Wallet Transaction History",
        description:
          "Retrieves the most recent Stellar transactions for a wallet from Horizon. Results are ordered newest first and can be paginated with cursor.",
        parameters: [
          {
            name: "address",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Stellar public key address of the wallet.",
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 200, default: 20 },
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Horizon paging token from the previous response.",
          },
        ],
        responses: {
          "200": {
            description: "Wallet transaction history",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    address: { type: "string" },
                    transactions: { type: "array", items: { type: "object" } },
                    nextCursor: { type: "string", nullable: true },
                  },
                  required: ["address", "transactions", "nextCursor"],
                },
              },
            },
          },
          "400": { description: "Invalid wallet address or pagination parameter" },
          "401": { description: "Missing or invalid tenant API key" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
    },
    "/wallet/{address}/balance": {
      get: {
        summary: "Get Wallet Balance",
        description:
          "Retrieves the Stellar account balances for a wallet from Horizon, including native and trustline assets.",
        parameters: [
          {
            name: "address",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Stellar public key address of the wallet.",
          },
        ],
        responses: {
          "200": {
            description: "Wallet balances",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    address: { type: "string" },
                    balances: { type: "array", items: { type: "object" } },
                  },
                  required: ["address", "balances"],
                },
              },
            },
          },
          "400": { description: "Invalid wallet address" },
          "401": { description: "Missing or invalid tenant API key" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
    },
    "/policy": {
      get: {
        summary: "List All Policies",
        description:
          "Returns all active wallet policies configured in the policy engine. Protected by API key authentication.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "List of all configured policies",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    policies: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Policy" },
                    },
                    count: { type: "integer", example: 3 },
                  },
                  required: ["policies", "count"],
                },
              },
            },
          },
          "401": { description: "Missing or invalid tenant API key" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
      post: {
        summary: "Create or Update Wallet Policy",
        description:
          "Configures spend limit, velocity, allowlist, or blocklist policy rules for a specific wallet.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  walletId: {
                    type: "string",
                    description: "Stellar public key address of the wallet.",
                    example: "GAD7654...",
                  },
                  rules: {
                    type: "array",
                    items: {
                      oneOf: [
                        { $ref: "#/components/schemas/SpendLimitRule" },
                        { $ref: "#/components/schemas/VelocityRule" },
                        { $ref: "#/components/schemas/AllowlistRule" },
                        { $ref: "#/components/schemas/BlocklistRule" },
                        { $ref: "#/components/schemas/AssetAllowlistRule" },
                      ],
                    },
                  },
                },
                required: ["walletId", "rules"],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Policy created successfully",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Policy" },
              },
            },
          },
          "401": { description: "Missing or invalid tenant API key" },
          "409": { description: "A policy already exists for this wallet" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
    },
    "/policy/{walletId}": {
      put: {
        summary: "Update Wallet Policy",
        description: "Replaces the rules of an existing wallet policy.",
        parameters: [
          {
            name: "walletId",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Stellar public key address of the wallet.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  walletId: {
                    type: "string",
                    description: "Must match the walletId in the URL.",
                    example: "GAD7654...",
                  },
                  rules: {
                    type: "array",
                    items: {
                      oneOf: [
                        { $ref: "#/components/schemas/SpendLimitRule" },
                        { $ref: "#/components/schemas/VelocityRule" },
                        { $ref: "#/components/schemas/AllowlistRule" },
                        { $ref: "#/components/schemas/AssetAllowlistRule" },
                      ],
                    },
                  },
                },
                required: ["walletId", "rules"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Policy updated successfully",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Policy" },
              },
            },
          },
          "401": { description: "Missing or invalid tenant API key" },
          "404": { description: "No policy found for wallet" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
      get: {
        summary: "Get Wallet Policy",
        description: "Retrieves active policy rules for a given wallet address.",
        parameters: [
          {
            name: "walletId",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Stellar public key address of the wallet.",
          },
        ],
        responses: {
          "200": {
            description: "Wallet policy details",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Policy" },
              },
            },
          },
          "401": { description: "Missing or invalid tenant API key" },
          "404": { description: "No policy found for wallet" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
      delete: {
        summary: "Delete Wallet Policy",
        description: "Deletes the wallet policy and clears its in-memory tracking data.",
        parameters: [
          {
            name: "walletId",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Stellar public key address of the wallet.",
          },
        ],
        responses: {
          "204": { description: "Policy deleted successfully" },
          "401": { description: "Missing or invalid tenant API key" },
          "404": { description: "No policy found for wallet" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
    },
    "/webhooks": {
      get: {
        summary: "List Webhooks",
        description: "Returns all registered webhook configurations (secrets omitted).",
        responses: {
          "200": {
            description: "List of registered webhooks",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/WebhookConfig" },
                },
              },
            },
          },
          "401": { description: "Missing or invalid tenant API key" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
      post: {
        summary: "Register Webhook",
        description: "Registers a new webhook endpoint to receive Lumen event notifications.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/WebhookRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "Webhook registered successfully",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WebhookConfig" },
              },
            },
          },
          "400": { description: "Invalid webhook configuration" },
          "401": { description: "Missing or invalid tenant API key" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
    },
    "/webhooks/{id}": {
      delete: {
        summary: "Delete Webhook",
        description: "Unregisters a webhook by its ID.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Webhook ID.",
          },
        ],
        responses: {
          "204": { description: "Webhook deleted" },
          "401": { description: "Missing or invalid tenant API key" },
          "404": { description: "Webhook not found" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
      patch: {
        summary: "Update Webhook",
        description:
          "Partially updates a webhook — toggle enabled state or change the subscribed event list. " +
          "At least one field must be provided. The webhook ID and secret cannot be changed.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Webhook ID.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  url: {
                    type: "string",
                    format: "uri",
                    description: "New destination URL.",
                    example: "https://example.com/webhook",
                  },
                  events: {
                    type: "array",
                    items: { type: "string" },
                    description: "Replacement event subscription list.",
                    example: ["transaction.cosigned", "wallet.created"],
                  },
                  enabled: {
                    type: "boolean",
                    description: "Set to false to pause delivery without deleting the webhook.",
                    example: false,
                  },
                },
                minProperties: 1,
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Webhook updated successfully",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WebhookConfig" },
              },
            },
          },
          "400": { description: "Invalid patch payload" },
          "401": { description: "Missing or invalid tenant API key" },
          "404": { description: "Webhook not found" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
    },
    "/webhooks/{id}/test": {
      post: {
        summary: "Send Test Webhook",
        description:
          "Dispatches a synthetic `test.ping` event to the registered webhook URL. " +
          "Useful for verifying endpoint reachability and signature validation without " +
          "triggering real on-chain activity.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Webhook ID.",
          },
        ],
        responses: {
          "200": {
            description: "Test delivery attempted",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: {
                      type: "boolean",
                      description: "Whether the remote server returned a 2xx response.",
                      example: true,
                    },
                    statusCode: {
                      type: "integer",
                      nullable: true,
                      description: "HTTP status code returned by the remote server.",
                      example: 200,
                    },
                    attempts: {
                      type: "integer",
                      description: "Always 1 for test deliveries.",
                      example: 1,
                    },
                    responseTimeMs: {
                      type: "integer",
                      description: "Round-trip time in milliseconds.",
                      example: 142,
                    },
                  },
                  required: ["success", "statusCode", "attempts", "responseTimeMs"],
                },
              },
            },
          },
          "401": { description: "Missing or invalid tenant API key" },
          "404": { description: "Webhook not found" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
    },
    "/webhooks/{id}/deliveries": {
      get: {
        summary: "List Webhook Deliveries",
        description:
          "Returns the delivery history for a webhook, including pending retries and deliveries routed to the dead-letter queue (DLQ).",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Webhook ID.",
          },
          {
            name: "status",
            in: "query",
            required: false,
            schema: {
              type: "string",
              enum: ["pending", "delivered", "failed", "dlq"],
            },
            description: "Filter deliveries by status.",
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            description: "Maximum number of deliveries to return.",
          },
          {
            name: "offset",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 0, default: 0 },
            description: "Number of deliveries to skip for pagination.",
          },
        ],
        responses: {
          "200": {
            description: "Webhook delivery history",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    deliveries: {
                      type: "array",
                      items: { $ref: "#/components/schemas/WebhookDelivery" },
                    },
                    total: { type: "integer", example: 12 },
                  },
                  required: ["deliveries", "total"],
                },
              },
            },
          },
          "401": { description: "Missing or invalid tenant API key" },
          "404": { description: "Webhook not found" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
    },
    "/webhooks/deliveries/{id}/retry": {
      post: {
        summary: "Retry Webhook Delivery",
        description:
          "Re-enqueues a failed or dead-lettered webhook delivery for another attempt using the standard retry pipeline.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Delivery ID.",
          },
        ],
        responses: {
          "200": {
            description: "Delivery re-enqueued for retry",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WebhookDelivery" },
              },
            },
          },
          "401": { description: "Missing or invalid tenant API key" },
          "404": { description: "Delivery not found" },
          "409": { description: "Delivery is not in a retryable state" },
          "429": { $ref: "#/components/responses/QuotaExceeded" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "API Key",
        description: "Tenant API key passed in the Authorization: Bearer <api-key> header",
      },
    },
    responses: {
      QuotaExceeded: {
        description:
          "Tenant has exceeded its monthly gas quota. Rate limit headers describe the current quota window.",
        headers: {
          "X-RateLimit-Limit": {
            description: "Monthly gas quota for the tenant, in XLM.",
            schema: { type: "string", example: "100" },
          },
          "X-RateLimit-Remaining": {
            description: "Remaining gas quota for the current period, in XLM.",
            schema: { type: "string", example: "0" },
          },
          "X-RateLimit-Reset": {
            description: "Unix timestamp (seconds) when the quota window resets.",
            schema: { type: "string", example: "1735689600" },
          },
          "Retry-After": {
            description: "Seconds until the quota window resets.",
            schema: { type: "string", example: "3600" },
          },
        },
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                error: { type: "string", example: "Monthly gas quota exceeded" },
                code: { type: "string", example: "QUOTA_EXCEEDED" },
                tier: { type: "string", example: "free" },
                monthlyGasQuotaXlm: { type: "string", example: "100" },
                usedGasXlm: { type: "string", example: "100.5" },
                resetsAt: { type: "string", format: "date-time" },
              },
              required: ["error", "code"],
            },
          },
        },
      },
    },
    schemas: {
      SpendLimitRule: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["spend_limit"] },
          asset: { type: "string", example: "USDC" },
          maxPerTx: { type: "string", example: "100.0" },
          maxDaily: { type: "string", example: "500.0" },
        },
        required: ["type", "asset", "maxPerTx", "maxDaily"],
      },
      VelocityRule: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["velocity"] },
          maxTransactions: { type: "integer", example: 10 },
          windowMinutes: { type: "integer", example: 60 },
        },
        required: ["type", "maxTransactions", "windowMinutes"],
      },
      AllowlistRule: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["allowlist"] },
          destinations: {
            type: "array",
            items: { type: "string" },
            example: ["GCB2..."],
          },
        },
        required: ["type", "destinations"],
      },
      BlocklistRule: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["blocklist"] },
          destinations: {
            type: "array",
            items: { type: "string" },
            example: ["GBAD..."],
          },
        },
        required: ["type", "destinations"],
      },
      AssetAllowlistRule: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["asset_allowlist"] },
          assets: {
            type: "array",
            items: { type: "string" },
            example: ["native", "USDC:GISSUER..."],
          },
        },
        required: ["type", "assets"],
      },
      MaxOperationsRule: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["max_operations"] },
          maxOperations: { type: "integer", example: 5 },
        },
        required: ["type", "maxOperations"],
      },
      ContractAllowlistRule: {
        type: "object",
        description:
          "Restricts Soroban smart contract invocations to an explicit allowlist of contract IDs and optional method names.",
        properties: {
          type: { type: "string", enum: ["contract_allowlist"] },
          allowedContracts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                contractId: {
                  type: "string",
                  description: "The Soroban contract address.",
                  example: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M",
                },
                methods: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Allowed method names. If omitted or empty, all methods are allowed.",
                  example: ["transfer", "approve"],
                },
              },
              required: ["contractId"],
            },
            minItems: 1,
          },
        },
        required: ["type", "allowedContracts"],
      },
      Policy: {
        type: "object",
        properties: {
          id: { type: "string", example: "550e8400-e29b-41d4-a716-446655440000" },
          walletId: { type: "string", example: "GAD7654..." },
          rules: { type: "array", items: { type: "object" } },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "walletId", "rules"],
      },
      WebhookConfig: {
        type: "object",
        description: "Registered webhook configuration (secret is never returned).",
        properties: {
          id: { type: "string", example: "550e8400-e29b-41d4-a716-446655440000" },
          url: { type: "string", format: "uri", example: "https://example.com/webhook" },
          events: {
            type: "array",
            items: { type: "string" },
            example: ["transaction.cosigned", "wallet.created"],
          },
          enabled: { type: "boolean", example: true },
        },
        required: ["id", "url", "events"],
      },
      WebhookRequest: {
        type: "object",
        properties: {
          id: { type: "string", description: "Optional custom ID; auto-generated if omitted." },
          url: { type: "string", format: "uri", example: "https://example.com/webhook" },
          secret: {
            type: "string",
            description: "HMAC-SHA256 signing secret used to verify delivery signatures.",
            example: "s3cr3t",
          },
          events: {
            type: "array",
            items: { type: "string" },
            example: ["transaction.cosigned"],
          },
          enabled: { type: "boolean", default: true },
        },
        required: ["url", "secret", "events"],
      },
      WebhookDelivery: {
        type: "object",
        description:
          "A single webhook delivery attempt record, including retry state and DLQ routing.",
        properties: {
          id: { type: "string", example: "550e8400-e29b-41d4-a716-446655440000" },
          webhookId: { type: "string", example: "550e8400-e29b-41d4-a716-446655440000" },
          event: