% Compute the L2 norm of a vector via sum-of-squares.
% Uses elementwise square + sum + sqrt — exercises the full pipeline.
v = [3 4];
sq = v .* v;
n2 = sum(sq);
disp(n2);
disp(sqrt(n2));

% Bigger example — note we assign the intermediate to a name. Inline
% tensor sub-expressions inside function-call args (e.g.
% `sqrt(sum(w .* w))`) are rejected at codegen until we materialize
% tensor temporaries automatically.
w = [1 2 3 4];
sqw = w .* w;
sw = sum(sqw);
disp(sw);
disp(sqrt(sw));

% With a column vector
c = [3; 4; 12];
sqc = c .* c;
disp(sqrt(sum(sqc)));
