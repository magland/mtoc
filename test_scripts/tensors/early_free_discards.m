% Exercise the early-free path: many tensors created and discarded
% between operations. Each tensor's last-touch comes well before
% scope exit, so the codegen emits per-tensor `mtoc_tensor_free`
% calls scattered through main() rather than batched at the end.
% Cross-runner only needs the stdout to match numbl byte-for-byte;
% this script is here so the early-free codegen path is exercised
% under the runner.

a = [1 2 3 4];
disp(sum(a));            % a dead immediately after this stmt

b = [10 20 30];
disp(b);                 % b dead immediately after this stmt

c = [1 2 3; 4 5 6];      % matrix
disp(c);                 % c dead

% Two tensors used together once, then dropped.
p = [1 2 3];
q = [10 20 30];
r = p + q;
disp(r);                 % p, q dead at the elementwise; r dead here

% A tensor reassigned at a different runtime shape — first buffer
% reclaimed by mtoc_tensor_assign, second buffer freed when v dies.
v = [1 2 3];
disp(v);
v = [10 20 30 40 50];
disp(v);                 % v dead

% Last operation: a tensor that survives until process exit (covered
% by the scope-exit free walk).
final = [99 98 97];
disp(final);
