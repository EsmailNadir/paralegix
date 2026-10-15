import { z } from 'zod';

export const checkUserExistsSchema = z.object({
  body: z.object({
    token: z.string().min(1, 'Token is required'),
  }),
});

export const completeRegistrationSchema = z.object({
  body: z.object({
    token: z.string().min(1, 'Token is required'),
    // `message`, not `errorMap`: Zod 4 renamed the option and silently ignores
    // the old name, which left this custom copy unreachable.
    userType: z.enum(['client', 'firm_member'], {
      message: 'userType must be "client" or "firm_member"',
    }),
    // Accepted so a client that still posts its sign-in popup tokens is not
    // refused, and ignored by the service: sign-in never stores calendar tokens.
    microsoftAccessToken: z.string().optional(),
    microsoftRefreshToken: z.string().optional(),
    googleAccessToken: z.string().optional(),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    token: z.string().min(1, 'Token is required'),
    // Accepted so a client that still posts its sign-in popup tokens is not
    // refused, and ignored by the service: sign-in never stores calendar tokens.
    microsoftAccessToken: z.string().optional(),
    microsoftRefreshToken: z.string().optional(),
    googleAccessToken: z.string().optional(),
  }),
});

export const createUserSchema = z.object({
  body: z.object({
    email: z.string().email(),
    name: z.string().optional(),
    // `message`, not `errorMap`: Zod 4 renamed the option and silently ignores
    // the old name, which left this custom copy unreachable.
    userType: z.enum(['client', 'firm_member'], {
      message: 'userType must be "client" or "firm_member"',
    }),
  }),
});

export const refreshMicrosoftTokenSchema = z.object({
  body: z.object({
    token: z.string().min(1, 'Token is required'),
  }),
});


export const connectMicrosoftSchema = z.object({
  body: z.object({
    returnUrl: z.string().optional(),
  }),
});

export const connectGoogleSchema = z.object({
  body: z.object({
    returnUrl: z.string().optional(),
  }),
});
