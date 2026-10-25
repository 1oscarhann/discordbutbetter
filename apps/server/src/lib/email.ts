import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface Mailer {
  enabled: boolean;
  send(to: string, subject: string, text: string): Promise<void>;
}

export function createMailer(config: Config, log: (msg: string) => void): Mailer {
  if (!config.smtp) {
    return {
      enabled: false,
      async send(to, subject) {
        log(`[email disabled] would send "${subject}" to ${to.replace(/(.).*@/, '$1***@')}`);
      },
    };
  }
  const transport = nodemailer.createTransport(config.smtp.url);
  const from = config.smtp.from;
  return {
    enabled: true,
    async send(to, subject, text) {
      await transport.sendMail({ from, to, subject, text });
    },
  };
}

export function verifyEmailText(appName: string, link: string): string {
  return `Hey!\n\nConfirm your email for ${appName} by opening this link:\n\n${link}\n\nIt expires in 24 hours. If you didn't sign up, ignore this email.\n`;
}

export function resetEmailText(appName: string, link: string): string {
  return `Someone (hopefully you) asked to reset your ${appName} password.\n\nReset it here:\n\n${link}\n\nThe link expires in 1 hour. If this wasn't you, ignore this email — your password hasn't changed.\n`;
}
