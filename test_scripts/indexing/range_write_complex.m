% Range / colon writes on a complex tensor.
z = [1+2i, 3+4i, 5+6i, 7+8i];
patch = [10+20i, 30+40i];
z(2:3) = patch;
disp(z);
% Real scalar broadcast into a complex slice — sets imag = 0.
z(1:2) = 99;
disp(z);
% Real-tensor RHS into a complex slice — also sets imag = 0 per slot.
real_patch = [-1 -2];
z(3:4) = real_patch;
disp(z);
% Colon broadcast
z(:) = 0;
disp(z);
% Complex scalar broadcast
z(:) = 1+1i;
disp(z);
