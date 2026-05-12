% sum / min / max on an N-D tensor built via reshape with literal
% positive-int dim args. The refined reshape result type carries
% notOne dims, so the reduction lowerer knows the shape is a
% matrix and collapses the first non-one axis.
v = [1 2 3 4 5 6 7 8 9 10 11 12];
A = reshape(v, 2, 3, 2);
disp(sum(A));
disp(min(A));
disp(max(A));
