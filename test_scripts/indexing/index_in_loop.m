% A small accumulator loop using indexing — exercises early-free
% liveness and the `mtoc_check_shape`-style invariants for tensors
% that are read but never mutated inside a loop body.
v = [3.0, 1.0, 4.0, 1.0, 5.0, 9.0, 2.0, 6.0];
n = length(v);
sum_v = 0;
prod_v = 1;
for k = 1:n
  sum_v = sum_v + v(k);
  prod_v = prod_v * v(k);
end
disp(sum_v);
disp(prod_v);

% A nested loop — tests that the index expression composes cleanly
% with surrounding control flow.
M = [1 2 3; 4 5 6];
total = 0;
for i = 1:2
  for j = 1:3
    total = total + M(i, j);
  end
end
disp(total);
