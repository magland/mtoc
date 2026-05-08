% Complex tensor element-wise: scalar broadcast, tensor + tensor,
% mixed real/complex tensors, structural-square nonneg refinement.
A = [1 + 2i, 3 + 4i];
B = [1, 2];

S = A + B;
disp(S);
S = A - B;
disp(S);
S = A .* B;
disp(S);

% Complex tensor + complex tensor.
C = [1i, 2i];
S = A + C;
disp(S);
S = A .* C;
disp(S);

% Real tensor + complex scalar (scalar broadcast).
D = [1, 2, 3];
S2 = D + (1 + 1i);
disp(S2);
S2 = D .* (2i);
disp(S2);

% Complex elementwise self-product.
SQ = A .* A;
disp(SQ);

% Reassign through complex element-wise.
z = [1 + 2i, 3];
w = [0 + 1i, 4];
z = z + w;
disp(z);
