% Element-wise logical-not `~` on tensor operands.

x = [-1 0 1 2 0];
n = ~x;
disp(n);

% Double-negation as identity over {0, 1}
nn = ~~x;
disp(nn);

% Column vector
cv = [0; 1; 0; 5];
nc = ~cv;
disp(nc);

% Matrix
M = [1 0; 0 1];
nm = ~M;
disp(nm);
