import type { Server } from "node:http";
import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  flattenInstructionPlan,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type InstructionPlan,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getCreateMintInstructionPlan,
  getMintToATAInstructionPlanAsync,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { Mppx, solana } from "@solana/mpp/client";

import { createServer } from "../../src/server.js";

export const defaultRpcUrl = process.env.SURFPOOL_RPC_URL ?? "http://127.0.0.1:8899";
export const splTokenDecimals = 6;

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type ParsedTransaction = {
  meta?: { err?: unknown } | null;
  transaction?: {
    message?: {
      instructions?: unknown[];
    };
  };
};

export async function rpc<Result>(
  url: string,
  method: string,
  params: unknown[] = [],
): Promise<Result> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  if (!response.ok) {
    throw new Error(`${method} HTTP ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as { result?: Result; error?: JsonRpcError };
  if (body.error) {
    const details = body.error.data === undefined ? "" : ` ${JSON.stringify(body.error.data)}`;
    throw new Error(`${method} RPC ${body.error.code}: ${body.error.message}${details}`);
  }
  return body.result as Result;
}

export async function assertRpcReady(url = defaultRpcUrl): Promise<void> {
  await rpc<string>(url, "getHealth");
}

export function createSigner(): Promise<TransactionSigner> {
  return generateKeyPairSigner();
}

export async function requestAirdrop(
  recipient: Address | string,
  lamports: bigint,
  url = defaultRpcUrl,
): Promise<Signature> {
  return rpc<Signature>(url, "requestAirdrop", [recipient, Number(lamports)]);
}

export async function airdropAndWait(
  recipient: Address | string,
  lamports: bigint,
  url = defaultRpcUrl,
): Promise<bigint> {
  const before = await getLamportBalance(recipient, url);
  await requestAirdrop(recipient, lamports, url);
  return waitForLamportBalanceAtLeast(recipient, before + lamports, url);
}

export async function getLamportBalance(
  accountAddress: Address | string,
  url = defaultRpcUrl,
): Promise<bigint> {
  const result = await rpc<{ value: number }>(url, "getBalance", [
    accountAddress,
    { commitment: "confirmed" },
  ]);
  return BigInt(result.value);
}

export async function waitForLamportBalanceAtLeast(
  accountAddress: Address | string,
  expected: bigint,
  url = defaultRpcUrl,
  timeoutMs = 30_000,
): Promise<bigint> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const balance = await getLamportBalance(accountAddress, url);
    if (balance >= expected) return balance;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${accountAddress} lamports to reach ${expected}`);
}

export async function createSplMint(
  input: {
    payer: TransactionSigner;
    mintAuthority: TransactionSigner;
    mint: TransactionSigner;
    decimals?: number;
  },
  url = defaultRpcUrl,
): Promise<Address> {
  const plan = getCreateMintInstructionPlan({
    payer: input.payer,
    newMint: input.mint,
    decimals: input.decimals ?? splTokenDecimals,
    mintAuthority: input.mintAuthority.address,
    freezeAuthority: null,
  });
  await sendInstructionPlan(plan, input.payer, url);
  return input.mint.address;
}

export async function mintSplTokensToOwner(
  input: {
    payer: TransactionSigner;
    mint: Address;
    mintAuthority: TransactionSigner;
    owner: Address;
    amount: bigint;
    decimals?: number;
  },
  url = defaultRpcUrl,
): Promise<void> {
  const plan = await getMintToATAInstructionPlanAsync({
    payer: input.payer,
    owner: input.owner,
    mint: input.mint,
    mintAuthority: input.mintAuthority,
    amount: input.amount,
    decimals: input.decimals ?? splTokenDecimals,
  });
  await sendInstructionPlan(plan, input.payer, url);
}

export async function createAssociatedTokenAccount(
  input: {
    payer: TransactionSigner;
    mint: Address;
    owner: Address;
  },
  url = defaultRpcUrl,
): Promise<Address> {
  const instruction = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: input.payer,
    mint: input.mint,
    owner: input.owner,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  await sendInstructions([instruction], input.payer, url);
  return deriveAssociatedTokenAccount(input.owner, input.mint);
}

export async function deriveAssociatedTokenAccount(
  owner: Address,
  mint: Address,
): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({
    owner,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return ata;
}

export async function getTokenBalance(
  owner: Address,
  mint: Address,
  url = defaultRpcUrl,
): Promise<bigint> {
  const ata = await deriveAssociatedTokenAccount(owner, mint);
  try {
    const result = await rpc<{ value: { amount: string } }>(url, "getTokenAccountBalance", [
      ata,
      { commitment: "confirmed" },
    ]);
    return BigInt(result.value.amount);
  } catch (error) {
    if (error instanceof Error && /could not find account|Invalid param/i.test(error.message)) {
      return 0n;
    }
    throw error;
  }
}

export async function waitForTokenBalanceAtLeast(
  owner: Address,
  mint: Address,
  expected: bigint,
  url = defaultRpcUrl,
  timeoutMs = 30_000,
): Promise<bigint> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const balance = await getTokenBalance(owner, mint, url);
    if (balance >= expected) return balance;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${owner} token balance to reach ${expected}`);
}

export async function waitForTransaction(
  signature: string,
  url = defaultRpcUrl,
  timeoutMs = 30_000,
): Promise<ParsedTransaction> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await rpc<ParsedTransaction | null>(url, "getTransaction", [
      signature,
      { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]);
    if (result) return result;
    await delay(500);
  }
  throw new Error(`Timed out waiting for transaction ${signature}`);
}

export async function startExpressServer(
  env: NodeJS.ProcessEnv,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = createServer(env);
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

export function createMppClient(
  payer: TransactionSigner,
  url = defaultRpcUrl,
): ReturnType<typeof Mppx.create> {
  return Mppx.create({
    methods: [solana.charge({ signer: payer, rpcUrl: url })],
    polyfill: false,
  });
}

async function sendInstructionPlan(
  plan: InstructionPlan,
  payer: TransactionSigner,
  url: string,
): Promise<Signature> {
  const instructions = flattenInstructionPlan(plan).map((leaf) => {
    if (leaf.kind !== "single") throw new Error("Instruction plan contains an unsupported packer");
    return leaf.instruction;
  });
  return sendInstructions(instructions, payer, url);
}

async function sendInstructions(
  instructions: Instruction[],
  payer: TransactionSigner,
  url: string,
): Promise<Signature> {
  const rpcClient = createSolanaRpc(url);
  const latestBlockhash = (await rpcClient.getLatestBlockhash().send()).value;
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(payer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const encoded = getBase64EncodedWireTransaction(signed);
  const signature = await rpc<Signature>(url, "sendTransaction", [
    encoded,
    { encoding: "base64", skipPreflight: false },
  ]);
  const transaction = await waitForTransaction(signature, url);
  if (transaction.meta?.err) {
    throw new Error(`Transaction ${signature} failed: ${JSON.stringify(transaction.meta.err)}`);
  }
  return signature;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
