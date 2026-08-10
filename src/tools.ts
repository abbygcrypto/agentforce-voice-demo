/**
 * Per-prospect tools.
 *
 * These are the actions the agent can actually take, not just talk about.
 * Each is defined once as an Anthropic tool schema plus a handler that returns
 * a plain object (serialized back to Claude as the tool result).
 *
 * The data here is mocked so the demo runs with no external systems. In a real
 * deployment each handler would hit the prospect's billing system, outage map,
 * scheduling API, etc. The seam is the handler body — nothing else changes.
 */

import type Anthropic from "@anthropic-ai/sdk";

export interface CustomerTool {
  spec: Anthropic.Tool;
  /** Executes the tool. Receives the validated-ish input from Claude. */
  run: (input: Record<string, unknown>) => Promise<unknown> | unknown;
}

/* ------------------------------------------------------------------ */
/* Northwind Energy (utility)                                          */
/* ------------------------------------------------------------------ */

// A tiny fake outage map keyed by ZIP prefix.
const OUTAGES: Record<string, { affected: number; etaMinutes: number; cause: string }> = {
  "load": { affected: 0, etaMinutes: 0, cause: "" }, // sentinel, unused
  "94103": { affected: 1240, etaMinutes: 90, cause: "equipment failure at a local substation" },
  "94107": { affected: 3, etaMinutes: 45, cause: "a downed line from high winds" },
};

// Fake account records keyed by the last 4 digits.
const ACCOUNTS: Record<string, { name: string; balance: number; dueDate: string; pastDue: boolean }> = {
  "4821": { name: "the account on file", balance: 84.17, dueDate: "the 22nd", pastDue: false },
  "0090": { name: "the account on file", balance: 213.55, dueDate: "the 3rd", pastDue: true },
};

const northwindTools: CustomerTool[] = [
  {
    spec: {
      name: "get_outage_status",
      description:
        "Look up the current power outage status for a ZIP code, including how many customers are affected and the estimated restoration time.",
      input_schema: {
        type: "object",
        properties: {
          zip: { type: "string", description: "5-digit ZIP code the caller is asking about" },
        },
        required: ["zip"],
      },
    },
    run: ({ zip }) => {
      const rec = OUTAGES[String(zip)];
      if (!rec || rec.affected === 0) {
        return { zip, outage: false, message: "No active outage reported for this area." };
      }
      return {
        zip,
        outage: true,
        customersAffected: rec.affected,
        estimatedRestorationMinutes: rec.etaMinutes,
        cause: rec.cause,
      };
    },
  },
  {
    spec: {
      name: "lookup_account_balance",
      description:
        "Retrieve the current balance and due date for a customer account, identified by the last four digits of their account number.",
      input_schema: {
        type: "object",
        properties: {
          lastFour: { type: "string", description: "Last four digits of the account number" },
        },
        required: ["lastFour"],
      },
    },
    run: ({ lastFour }) => {
      const rec = ACCOUNTS[String(lastFour)];
      if (!rec) {
        return { found: false, message: "No account matches those digits. Ask the caller to re-read them." };
      }
      return {
        found: true,
        balanceUsd: rec.balance,
        dueDate: rec.dueDate,
        pastDue: rec.pastDue,
      };
    },
  },
];

/* ------------------------------------------------------------------ */
/* Meridian Health Group (healthcare)                                  */
/* ------------------------------------------------------------------ */

const CLINICS: Record<string, { address: string; hours: string; nextOpening: string }> = {
  fairview: { address: "410 Fairview Ave", hours: "8am–6pm weekdays", nextOpening: "tomorrow at 9:15am" },
  lakeside: { address: "72 Lakeside Dr", hours: "8am–6pm weekdays", nextOpening: "Thursday at 2:00pm" },
  downtown: { address: "1 Center Plaza", hours: "8am–6pm weekdays", nextOpening: "Friday at 11:30am" },
};

const meridianTools: CustomerTool[] = [
  {
    spec: {
      name: "find_clinic",
      description:
        "Look up a Meridian clinic's address, hours, and the next available appointment opening.",
      input_schema: {
        type: "object",
        properties: {
          clinic: {
            type: "string",
            description: "Clinic name: fairview, lakeside, or downtown",
            enum: ["fairview", "lakeside", "downtown"],
          },
        },
        required: ["clinic"],
      },
    },
    run: ({ clinic }) => {
      const rec = CLINICS[String(clinic).toLowerCase()];
      if (!rec) return { found: false, message: "Unknown clinic. Offer Fairview, Lakeside, or Downtown." };
      return { found: true, clinic, ...rec };
    },
  },
  {
    spec: {
      name: "reschedule_appointment",
      description:
        "Move an existing appointment to a new date and time after the caller's identity has been verified.",
      input_schema: {
        type: "object",
        properties: {
          clinic: { type: "string", enum: ["fairview", "lakeside", "downtown"] },
          newDateTime: { type: "string", description: "The requested new date and time, in plain words" },
        },
        required: ["clinic", "newDateTime"],
      },
    },
    run: ({ clinic, newDateTime }) => {
      // In production this would write to the scheduling system.
      return {
        confirmed: true,
        clinic,
        newDateTime,
        confirmationCode: "MHG-7731",
        message: "Appointment moved. Read back the new time and the confirmation code.",
      };
    },
  },
];

/* ------------------------------------------------------------------ */

const TOOLS_BY_CUSTOMER: Record<string, CustomerTool[]> = {
  energy: northwindTools,
  healthcare: meridianTools,
};

export function getToolsForCustomer(customerId: string): CustomerTool[] {
  return TOOLS_BY_CUSTOMER[customerId] ?? [];
}
