% Element-wise comparisons on tensor operands with scalar broadcast.

x = [-2 -1 0 1 2];

eqz = x == 0;
disp(eqz);
nez = x ~= 0;
disp(nez);
ltz = x < 0;
disp(ltz);
lez = x <= 0;
disp(lez);
gtz = x > 0;
disp(gtz);
gez = x >= 0;
disp(gez);

% Tensor vs tensor (same shape)
y = [-1 -1 0 1 1];
eq = x == y;
disp(eq);
lt = x < y;
disp(lt);

% Column vector + scalar
cv = [10; 20; 30];
gtcv = cv > 15;
disp(gtcv);

% Matrix
M = [1 2; 3 4];
ltM = M < 3;
disp(ltM);
