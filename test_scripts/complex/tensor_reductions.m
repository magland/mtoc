% sum on complex vectors. Result type is complex scalar; matches
% numbl byte-for-byte (formatted via formatComplex).
A = [1 + 2i, 3 + 4i, 5 - 6i];
disp(sum(A));

% Pure-imag vector → pure-imag sum.
B = [1i, 2i, 3i];
disp(sum(B));

% Mixed real-and-complex (the literal is complex because at least one
% cell is complex; real cells contribute imag=0).
C = [1, 2 + 3i, 4];
disp(sum(C));

% length / numel still work on complex tensors (introspection only —
% they don't care about isComplex).
disp(length(A));
disp(numel(A));

% Real-vector sum still goes through the real path.
R = [1, 2, 3, 4];
disp(sum(R));
