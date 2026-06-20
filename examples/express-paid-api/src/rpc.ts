export type RpcBalanceReader = {
  getBalance(address: string): Promise<bigint>;
};

export function createRpcBalanceReader(rpcUrl: string): RpcBalanceReader {
  return {
    async getBalance(accountAddress: string): Promise<bigint> {
      const result = await rpc<{ value: number }>(rpcUrl, "getBalance", [
        accountAddress,
        { commitment: "confirmed" },
      ]);
      return BigInt(result.value);
    },
  };
}

async function rpc<Result>(
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

  const body = (await response.json()) as {
    result?: Result;
    error?: { code: number; message: string };
  };
  if (body.error) throw new Error(`${method} RPC ${body.error.code}: ${body.error.message}`);
  return body.result as Result;
}
