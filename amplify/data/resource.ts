import { type ClientSchema, a, defineData } from '@aws-amplify/backend';

const schema = a.schema({
  Poll: a
    .model({
      question: a.string().required(),
      optionA: a.string().required(),
      optionB: a.string().required(),
      votesA: a.integer().required(),
      votesB: a.integer().required(),

      // New: timers, closing polls, and "reset votes for everyone"
      isClosed: a.boolean().default(false),
      endsAt: a.datetime(),
      epoch: a.integer().default(0),
    })
    .authorization((allow) => [allow.publicApiKey()]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'apiKey',
    apiKeyAuthorizationMode: {
      expiresInDays: 30,
    },
  },
});