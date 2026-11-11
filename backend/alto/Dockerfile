# alto ERC-4337 bundler（自架於 Railway）
#
# 基底 image pin 在 v1.2.5：v1.2.8 的 SafeValidator 對 EntryPoint v0.7 是壞的
# （decodeErrorResult 用了零 error 條目的 ABI，任何 UserOp 都失敗）。
# 詳見 spike/alto/V125-VERDICT.md；safe-mode=true 已實測能擋下偽造簽章與過低 gas。
FROM ghcr.io/pimlicolabs/alto:v1.2.5

# 只加一層：把環境變數轉成 CLI 參數（Railway 上沒有地方放 config 檔）。
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
